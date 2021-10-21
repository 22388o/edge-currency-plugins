import { add, sub } from 'biggystring'
import {
  EdgeFreshAddress,
  EdgeIo,
  EdgeLog,
  EdgeTransaction,
  EdgeWalletInfo
} from 'edge-core-js/types'

import { EngineEmitter, EngineEvent } from '../../plugin/makeEngineEmitter'
import {
  AddressPath,
  CurrencyFormat,
  EngineConfig,
  EngineCurrencyInfo,
  NetworkEnum
} from '../../plugin/types'
import { removeItem } from '../../plugin/utils'
import { Processor } from '../db/makeProcessor'
import { toEdgeTransaction } from '../db/Models/ProcessorTransaction'
import {
  IAddress,
  IProcessorTransaction,
  IUTXO,
  makeIAddress
} from '../db/types'
import { BIP43PurposeTypeEnum, ScriptTypeEnum } from '../keymanager/keymanager'
import {
  IAccountDetailsBasic,
  IAccountUTXO,
  ITransactionDetailsPaginationResponse
} from '../network/BlockBook'
import {
  addressMessage,
  addressUtxosMessage,
  asAddressUtxos,
  asITransaction,
  INewTransactionResponse,
  ITransaction,
  transactionMessage
} from '../network/BlockBookAPI'
import Deferred from '../network/Deferred'
import { WsTask } from '../network/Socket'
import AwaitLock from './await-lock'
import { BLOCKBOOK_TXS_PER_PAGE, CACHE_THROTTLE } from './constants'
import { makeServerStates, ServerStates } from './makeServerStates'
import { UTXOPluginWalletTools } from './makeUtxoWalletTools'
import {
  currencyFormatToPurposeType,
  getCurrencyFormatFromPurposeType,
  getFormatSupportedBranches,
  getPurposeTypeFromKeys,
  getWalletSupportedFormats,
  validScriptPubkeyFromAddress
} from './utils'

export interface UtxoEngineState {
  processedPercent: number

  start: () => Promise<void>

  stop: () => Promise<void>

  getFreshAddress: (branch?: number) => Promise<EdgeFreshAddress>

  addGapLimitAddresses: (addresses: string[]) => Promise<void>

  broadcastTx: (transaction: EdgeTransaction) => Promise<string>

  refillServers: () => void

  getServerList: () => string[]

  setServerList: (serverList: string[]) => void
}

export interface UtxoEngineStateConfig extends EngineConfig {
  walletTools: UTXOPluginWalletTools
  processor: Processor
}

export function makeUtxoEngineState(
  config: UtxoEngineStateConfig
): UtxoEngineState {
  const {
    network,
    currencyInfo,
    walletInfo,
    walletTools,
    options: { emitter, log },
    processor,
    pluginState
  } = config

  const taskCache: TaskCache = {
    addressWatching: false,
    blockWatching: false,
    addressSubscribeCache: {},
    transactionsCache: {},
    utxosCache: {},
    rawUtxosCache: {},
    processedUtxosCache: {},
    updateTransactionsCache: {}
  }

  const clearTaskCache = (): void => {
    taskCache.addressWatching = false
    taskCache.blockWatching = false
    taskCache.addressSubscribeCache = {}
    taskCache.transactionsCache = {}
    taskCache.utxosCache = {}
    taskCache.rawUtxosCache = {}
    taskCache.processedUtxosCache = {}
    taskCache.updateTransactionsCache = {}
  }

  let processedCount = 0
  let processedPercent = 0
  const onAddressChecked = async (): Promise<void> => {
    processedCount = processedCount + 1
    const totalCount = await getTotalAddressCount(walletInfo, processor)
    const percent = processedCount / totalCount
    if (percent - processedPercent > CACHE_THROTTLE || percent === 1) {
      log(
        `processed changed, percent: ${percent}, processedCount: ${processedCount}, totalCount: ${totalCount}`
      )
      processedPercent = percent
      emitter.emit(EngineEvent.ADDRESSES_CHECKED, percent)
    }
  }

  const engineStarted = false
  const lock = new AwaitLock()

  const serverStates = makeServerStates({
    engineStarted,
    walletInfo,
    pluginState,
    engineEmitter: emitter,
    log
  })
  const commonArgs: CommonArgs = {
    engineStarted,
    network,
    currencyInfo,
    walletInfo,
    walletTools,
    processor,
    emitter,
    taskCache,
    onAddressChecked,
    io: config.io,
    log,
    serverStates,
    lock
  }

  const pickNextTaskCB = async (
    uri: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<boolean | WsTask<any> | undefined> => {
    return await pickNextTask({ ...commonArgs, uri })
  }

  serverStates.setPickNextTaskCB(pickNextTaskCB)

  let running = false
  const run = async (): Promise<void> => {
    if (running) return
    running = true

    const formatsToProcess = getWalletSupportedFormats(walletInfo)
    for (const format of formatsToProcess) {
      const branches = getFormatSupportedBranches(format)
      for (const branch of branches) {
        await setLookAhead(commonArgs, { format, branch })
      }
    }
  }

  emitter.on(
    EngineEvent.BLOCK_HEIGHT_CHANGED,
    async (_uri: string, _blockHeight: number): Promise<void> => {
      const txs = await processor.fetchTransactions({
        blockHeight: 0
      })
      for (const tx of txs) {
        if (tx == null) continue
        taskCache.updateTransactionsCache[tx.txid] = { processing: false }
      }
    }
  )

  emitter.on(
    EngineEvent.NEW_ADDRESS_TRANSACTION,
    async (_uri: string, response: INewTransactionResponse): Promise<void> => {
      const state = taskCache.addressSubscribeCache[response.address]
      if (state != null) {
        const { path } = state
        taskCache.utxosCache[response.address] = {
          processing: false,
          path
        }
        addToTransactionCache(
          commonArgs,
          response.address,
          path.format,
          path.branch,
          0,
          taskCache.transactionsCache
        ).catch(() => {
          throw new Error('failed to add to transaction cache')
        })
        setLookAhead(commonArgs, path).catch(e => {
          log(e)
        })
      }
    }
  )

  return {
    processedPercent,
    async start(): Promise<void> {
      processedCount = 0
      processedPercent = 0

      await run()
      serverStates.refillServers()
    },

    async stop(): Promise<void> {
      serverStates.stop()
      clearTaskCache()
      running = false
    },

    async getFreshAddress(branch = 0): Promise<EdgeFreshAddress> {
      const walletPurpose = getPurposeTypeFromKeys(walletInfo)
      if (walletPurpose === BIP43PurposeTypeEnum.Segwit) {
        const { address: publicAddress } = await internalGetFreshAddress({
          ...commonArgs,
          format: getCurrencyFormatFromPurposeType(
            BIP43PurposeTypeEnum.WrappedSegwit
          ),
          branch: branch
        })

        const { address: segwitAddress } = await internalGetFreshAddress({
          ...commonArgs,
          format: getCurrencyFormatFromPurposeType(BIP43PurposeTypeEnum.Segwit),
          branch: branch
        })

        return {
          publicAddress,
          segwitAddress
        }
      } else {
        // Airbitz wallets only use branch 0
        if (walletPurpose !== BIP43PurposeTypeEnum.Airbitz) {
          branch = 0
        }

        const {
          address: publicAddress,
          legacyAddress
        } = await internalGetFreshAddress({
          ...commonArgs,
          format: getCurrencyFormatFromPurposeType(walletPurpose),
          branch: branch
        })

        return {
          publicAddress,
          legacyAddress:
            legacyAddress !== publicAddress ? legacyAddress : undefined
        }
      }
    },

    async addGapLimitAddresses(addresses: string[]): Promise<void> {
      const promises = addresses.map(async address => {
        const scriptPubkey = walletTools.addressToScriptPubkey(address)
        await processor.saveAddress(
          makeIAddress({
            scriptPubkey,
            used: true
          })
        )
      })
      await Promise.all(promises)
      await run()
    },

    async broadcastTx(transaction: EdgeTransaction): Promise<string> {
      // put spent utxos into an interim data structure (saveSpentUtxo)
      // these utxos are removed once the transaction confirms
      const [tx] = await processor.fetchTransactions({ txId: transaction.txid })
      if (tx != null) {
        for (const inputs of tx.inputs) {
          const [utxo] = await processor.fetchUtxos({
            utxoIds: [`${inputs.txId}_${inputs.outputIndex}`]
          })
          if (utxo != null) {
            utxo.spent = true
            await processor.saveUtxo(utxo)
          }
        }
      }
      const txId = await serverStates.broadcastTx(transaction)
      return txId
    },
    refillServers(): void {
      serverStates.refillServers()
    },
    getServerList(): string[] {
      return serverStates.getServerList()
    },
    setServerList(serverList: string[]) {
      serverStates.setServerList(serverList)
    }
  }
}

interface CommonArgs {
  engineStarted: boolean
  network: NetworkEnum
  currencyInfo: EngineCurrencyInfo
  walletInfo: EdgeWalletInfo
  walletTools: UTXOPluginWalletTools
  processor: Processor
  emitter: EngineEmitter
  taskCache: TaskCache
  onAddressChecked: () => void
  io: EdgeIo
  log: EdgeLog
  serverStates: ServerStates
  lock: AwaitLock
}

interface ShortPath {
  format: CurrencyFormat
  branch: number
}
interface TaskCache {
  addressWatching: boolean
  blockWatching: boolean
  addressSubscribeCache: AddressSubscribeCache
  utxosCache: UtxosCache
  rawUtxosCache: RawUtxoCache
  processedUtxosCache: ProcessedUtxoCache
  transactionsCache: AddressTransactionCache
  updateTransactionsCache: UpdateTransactionCache
}

interface UpdateTransactionCache {
  [key: string]: { processing: boolean }
}
interface AddressSubscribeCache {
  [key: string]: { processing: boolean; path: ShortPath }
}
interface UtxosCache {
  [key: string]: { processing: boolean; path: ShortPath }
}
interface ProcessedUtxoCache {
  [key: string]: {
    processing: boolean
    full: boolean
    utxos: Set<IUTXO>
    path: ShortPath
  }
}
interface RawUtxoCache {
  [key: string]: {
    processing: boolean
    path: ShortPath
    address: Required<IAddress>
    requiredCount: number
  }
}
interface AddressTransactionCache {
  [key: string]: {
    processing: boolean
    path: ShortPath
    page: number
    blockHeight: number
  }
}

interface FormatArgs extends CommonArgs, ShortPath {}

const setLookAhead = async (
  common: CommonArgs,
  shortPath: ShortPath
): Promise<void> => {
  const { currencyInfo, lock, processor, taskCache, walletTools } = common
  const addressesToSubscribe = new Set<string>()
  const formatPath: Omit<AddressPath, 'addressIndex'> = {
    format: shortPath.format,
    changeIndex: shortPath.branch
  }

  // Wait for the lock to be released before continuing invocation.
  // This is to ensure that setLockAhead is not called while the lock is held.
  await lock.acquireAsync()

  try {
    let totalAddressCount = processor.numAddressesByFormatPath(formatPath)
    let lastUsedIndex = await processor.lastUsedIndexByFormatPath({
      ...formatPath
    })

    // Initialize the addressSubscribeCache with the existing addresses already
    // processed by the processor. This happens only once on the first
    // setLookAheadCall. The addressSubscribeCache size should be equal to the
    // sum of each totalAddressCount per branch.
    if (
      Object.keys(taskCache.addressSubscribeCache).length <
      totalAddressCount * (shortPath.branch + 1)
    ) {
      // If the processor has not processed any addresses then the loop
      // condition will only iterate once when totalAddressCount is 0 for the
      // first address in the derivation path.
      for (
        let addressIndex = 0;
        addressIndex < totalAddressCount;
        addressIndex++
      ) {
        addressesToSubscribe.add(
          walletTools.getAddress({ ...formatPath, addressIndex }).address
        )
      }
    }

    // Loop until the total address count equals the lookahead count
    let lookAheadCount = lastUsedIndex + currencyInfo.gapLimit + 1
    while (totalAddressCount < lookAheadCount) {
      const path: AddressPath = {
        ...formatPath,
        addressIndex: totalAddressCount
      }
      const { address } = walletTools.getAddress(path)
      const scriptPubkey = walletTools.addressToScriptPubkey(address)

      // Make a new IAddress and save it
      await processor.saveAddress(makeIAddress({ scriptPubkey, path }))

      // Add the displayAddress to the set of addresses to subscribe to after loop
      addressesToSubscribe.add(address)

      // Update the state for the loop
      lastUsedIndex = await processor.lastUsedIndexByFormatPath({
        ...formatPath
      })
      totalAddressCount = processor.numAddressesByFormatPath(formatPath)
      lookAheadCount = lastUsedIndex + currencyInfo.gapLimit + 1
    }

    // Add all the addresses to the subscribe cache for registering subscriptions later
    addToAddressSubscribeCache(common, addressesToSubscribe, shortPath)
  } finally {
    lock.release()
  }
}

const addToAddressSubscribeCache = (
  args: CommonArgs,
  addresses: Set<string>,
  path: ShortPath
): void => {
  addresses.forEach(address => {
    args.taskCache.addressSubscribeCache[address] = {
      path,
      processing: false
    }
    args.taskCache.addressWatching = false
  })
}

const addToTransactionCache = async (
  args: CommonArgs,
  address: string,
  format: CurrencyFormat,
  branch: number,
  blockHeight: number,
  transactions: AddressTransactionCache
): Promise<void> => {
  const { walletTools, processor } = args
  // Fetch the blockHeight for the address from the database
  const scriptPubkey = walletTools.addressToScriptPubkey(address)

  if (blockHeight === 0) {
    const { lastQueriedBlockHeight = 0 } =
      (await processor.fetchAddress(scriptPubkey)) ?? {}
    blockHeight = lastQueriedBlockHeight
  }

  transactions[address] = {
    processing: false,
    path: {
      format,
      branch
    },
    page: 1, // Page starts on 1
    blockHeight
  }
}

interface TransactionChangedArgs {
  tx: IProcessorTransaction
  emitter: EngineEmitter
  walletTools: UTXOPluginWalletTools
  currencyInfo: EngineCurrencyInfo
  processor: Processor
}

export const transactionChanged = async (
  args: TransactionChangedArgs
): Promise<void> => {
  const { emitter, walletTools, processor, currencyInfo, tx } = args
  emitter.emit(EngineEvent.TRANSACTIONS_CHANGED, [
    await toEdgeTransaction({
      tx,
      currencyCode: currencyInfo.currencyCode,
      walletTools,
      processor
    })
  ])
}

interface NextTaskArgs extends CommonArgs {
  uri: string
}

export const pickNextTask = async (
  args: NextTaskArgs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<WsTask<any> | undefined | boolean> => {
  const { taskCache, uri, serverStates } = args

  const {
    addressSubscribeCache,
    utxosCache,
    rawUtxosCache,
    processedUtxosCache,
    transactionsCache,
    updateTransactionsCache
  } = taskCache

  const serverState = serverStates.getServerState(uri)
  if (serverState == null) return

  // subscribe all servers to new blocks
  if (!serverState.subscribedBlocks) {
    serverState.subscribedBlocks = true
    const queryTime = Date.now()
    const deferredBlockSub = new Deferred<unknown>()
    deferredBlockSub.promise
      .then(() => {
        serverStates.serverScoreUp(uri, Date.now() - queryTime)
      })
      .catch(() => {
        serverState.subscribedBlocks = false
      })
    serverStates.watchBlocks(uri, deferredBlockSub)
    return true
  }

  // Loop processed utxos, these are just database ops, triggers setLookAhead
  if (Object.keys(processedUtxosCache).length > 0) {
    for (const scriptPubkey of Object.keys(processedUtxosCache)) {
      // Only process when all utxos for a specific address have been gathered
      const state = processedUtxosCache[scriptPubkey]
      if (!state.processing && state.full) {
        state.processing = true
        await processUtxoTransactions({
          ...args,
          scriptPubkey,
          utxos: state.utxos,
          path: state.path
        })
        removeItem(processedUtxosCache, scriptPubkey)
        return true
      }
    }
  }

  // Loop unparsed utxos, some require a network call to get the full tx data
  for (const utxoString of Object.keys(rawUtxosCache)) {
    const state = rawUtxosCache[utxoString]
    const utxo: IAccountUTXO = JSON.parse(utxoString)
    if (utxo == null) continue
    if (!state.processing) {
      // check if we need to fetch additional network content for legacy purpose type
      const purposeType = currencyFormatToPurposeType(state.path.format)
      if (
        purposeType === BIP43PurposeTypeEnum.Airbitz ||
        purposeType === BIP43PurposeTypeEnum.Legacy
      ) {
        // if we do need to make a network call, check with the serverState
        if (!serverStates.serverCanGetTx(uri, utxo.txid)) return
      }
      state.processing = true
      removeItem(rawUtxosCache, utxoString)
      const wsTask = await processRawUtxo({
        ...args,
        ...state,
        ...state.path,
        address: state.address,
        utxo,
        id: `${utxo.txid}_${utxo.vout}`
      })
      return wsTask ?? true
    }
  }

  // Loop to process addresses to utxos
  for (const address of Object.keys(utxosCache)) {
    const state = utxosCache[address]
    // Check if we need to fetch address UTXOs
    if (!state.processing && serverStates.serverCanGetAddress(uri, address)) {
      state.processing = true

      removeItem(utxosCache, address)

      // Fetch and process address UTXOs
      const wsTask = await processAddressUtxos({
        ...args,
        ...state,
        address
      })
      wsTask.deferred.promise
        .then(() => {
          serverState.addresses.add(address)
        })
        .catch(e => {
          throw e
        })
      return wsTask
    }
  }

  // Check if there are any addresses pending to be subscribed
  if (
    Object.keys(addressSubscribeCache).length > 0 &&
    !taskCache.addressWatching
  ) {
    const blockHeight = serverStates.getBlockHeight(uri)
    // Loop each address that needs to be subscribed
    for (const address of Object.keys(addressSubscribeCache)) {
      const state = addressSubscribeCache[address]
      // Add address in the cache to the set of addresses to watch
      const { path, processing: subscribed } = state
      // only process newly watched addresses
      if (subscribed) continue
      if (path != null) {
        // Add the newly watched addresses to the UTXO cache
        utxosCache[address] = {
          processing: false,
          path
        }
        await addToTransactionCache(
          args,
          address,
          path.format,
          path.branch,
          blockHeight,
          transactionsCache
        )
      }
      state.processing = true
    }

    taskCache.addressWatching = true

    const queryTime = Date.now()
    const deferredAddressSub = new Deferred<unknown>()
    deferredAddressSub.promise
      .then(() => {
        serverStates.serverScoreUp(uri, Date.now() - queryTime)
      })
      .catch(() => {
        taskCache.addressWatching = false
      })
    deferredAddressSub.promise.catch(() => {
      taskCache.addressWatching = false
    })
    serverStates.watchAddresses(
      uri,
      Array.from(Object.keys(addressSubscribeCache)),
      deferredAddressSub
    )
    return true
  }

  // filled when transactions potentially changed (e.g. through new block notification)
  if (Object.keys(updateTransactionsCache).length > 0) {
    for (const txId of Object.keys(updateTransactionsCache)) {
      if (
        !updateTransactionsCache[txId].processing &&
        serverStates.serverCanGetTx(uri, txId)
      ) {
        updateTransactionsCache[txId].processing = true
        removeItem(updateTransactionsCache, txId)
        const updateTransactionTask = updateTransactions({ ...args, txId })
        // once resolved, add the txid to the server cache
        updateTransactionTask.deferred.promise
          .then(() => {
            serverState.txids.add(txId)
          })
          .catch(e => {
            throw e
          })
        return updateTransactionTask
      }
    }
    return true
  }

  // loop to get and process transaction history of single addresses, triggers setLookAhead
  for (const address of Object.keys(transactionsCache)) {
    const state = transactionsCache[address]
    if (!state.processing && serverStates.serverCanGetAddress(uri, address)) {
      state.processing = true

      removeItem(transactionsCache, address)

      // Fetch and process address UTXOs
      const wsTask = await processAddressTransactions({
        ...args,
        ...state,
        address
      })
      wsTask.deferred.promise
        .then(() => {
          serverState.addresses.add(address)
        })
        .catch(e => {
          throw e
        })
      return wsTask
    }
  }
}

interface UpdateTransactionsArgs extends CommonArgs {
  txId: string
}

const updateTransactions = (
  args: UpdateTransactionsArgs
): WsTask<ITransaction> => {
  const { txId, processor, taskCache } = args
  const deferredITransaction = new Deferred<ITransaction>()
  deferredITransaction.promise
    .then(async (rawTx: ITransaction) => {
      const tx = processRawTx({ ...args, tx: rawTx })
      // check if tx is still not confirmed, if so, don't change anything
      if (tx.blockHeight < 1) {
        return
      }
      for (const input of tx.inputs) {
        await processor.removeUtxos([`${input.txId}_${input.outputIndex}`])
      }
      await processor.saveTransaction({
        tx
      })
      await transactionChanged({ ...args, tx })
    })
    .catch(() => {
      taskCache.updateTransactionsCache[txId] = { processing: false }
    })
  return {
    ...transactionMessage(txId),
    cleaner: asITransaction,
    deferred: deferredITransaction
  }
}

const getTotalAddressCount = async (
  walletInfo: EdgeWalletInfo,
  processor: Processor
): Promise<number> => {
  const walletFormats = getWalletSupportedFormats(walletInfo)

  let count = 0
  for (const format of walletFormats) {
    const branches = getFormatSupportedBranches(format)
    for (const branch of branches) {
      const addressCount = processor.numAddressesByFormatPath({
        format,
        changeIndex: branch
      })
      count += addressCount
    }
  }
  return count
}

interface GetFreshAddressArgs extends FormatArgs {}

interface GetFreshAddressReturn {
  address: string
  legacyAddress: string
}

const internalGetFreshAddress = async (
  args: GetFreshAddressArgs
): Promise<GetFreshAddressReturn> => {
  const { format, branch, walletTools, processor } = args

  const numAddresses = processor.numAddressesByFormatPath({
    format,
    changeIndex: branch
  })

  const path: AddressPath = {
    format,
    changeIndex: branch,
    // while syncing, we may hit negative numbers when only subtracting. Use the address at /0 in that case.
    addressIndex: Math.max(numAddresses - args.currencyInfo.gapLimit, 0)
  }
  const { scriptPubkey } =
    (await processor.fetchAddress(path)) ??
    (await walletTools.getScriptPubkey(path))
  if (scriptPubkey == null) {
    throw new Error('Unknown address path')
  }
  return walletTools.scriptPubkeyToAddress({
    scriptPubkey,
    format
  })
}

interface ProcessAddressTxsArgs extends CommonArgs {
  processing: boolean
  page: number
  blockHeight: number
  path: ShortPath
  address: string
  uri: string
}

type AddressResponse = IAccountDetailsBasic &
  ITransactionDetailsPaginationResponse

const processAddressTransactions = async (
  args: ProcessAddressTxsArgs
): Promise<WsTask<AddressResponse>> => {
  const {
    address,
    page = 1,
    blockHeight,
    processor,
    walletTools,
    path,
    taskCache,
    serverStates,
    uri
  } = args
  const transactionsCache = taskCache.transactionsCache

  const scriptPubkey = walletTools.addressToScriptPubkey(address)
  const addressData = await processor.fetchAddress(scriptPubkey)
  if (addressData == null) {
    throw new Error(`could not find address with script pubkey ${scriptPubkey}`)
  }

  const queryTime = Date.now()
  const deferredAddressResponse = new Deferred<AddressResponse>()
  deferredAddressResponse.promise
    .then(async (value: AddressResponse) => {
      serverStates.serverScoreUp(uri, Date.now() - queryTime)
      const { transactions = [], txs, unconfirmedTxs, totalPages } = value

      // If address is used and previously not marked as used, mark as used.
      const used = txs > 0 || unconfirmedTxs > 0

      if (!addressData.used && used && page === 1) {
        addressData.used = true
        await processor.saveAddress(addressData)
        await setLookAhead(args, path)
      }

      for (const rawTx of transactions) {
        const tx = processRawTx({ ...args, tx: rawTx })
        await processor.saveTransaction({ tx, scriptPubkey })
        await transactionChanged({ ...args, tx })
      }

      if (page < totalPages) {
        // Add the address back to the cache, incrementing the page
        transactionsCache[address] = {
          path,
          processing: false,
          blockHeight,
          page: page + 1
        }
      } else {
        addressData.lastQueriedBlockHeight = blockHeight
        await processor.saveAddress(addressData)

        await setLookAhead(args, path)

        // Callback for when an address has been fully processed
        args.onAddressChecked()
      }
    })
    .catch(() => {
      args.processing = false
      transactionsCache[address] = {
        path,
        processing: args.processing,
        blockHeight,
        page
      }
    })
  return {
    ...addressMessage(address, {
      details: 'txs',
      from: addressData.lastQueriedBlockHeight,
      perPage: BLOCKBOOK_TXS_PER_PAGE,
      page
    }),
    deferred: deferredAddressResponse
  }
}

interface ProcessRawTxArgs extends CommonArgs {
  tx: ITransaction
}

const processRawTx = (args: ProcessRawTxArgs): IProcessorTransaction => {
  const { tx, currencyInfo } = args
  return {
    txid: tx.txid,
    hex: tx.hex,
    // Blockbook can return a blockHeight of -1 when the tx is pending in the mempool
    blockHeight: tx.blockHeight > 0 ? tx.blockHeight : 0,
    date: tx.blockTime,
    fees: tx.fees,
    inputs: tx.vin.map(input => ({
      txId: input.txid,
      outputIndex: input.vout, // case for tx `fefac8c22ba1178df5d7c90b78cc1c203d1a9f5f5506f7b8f6f469fa821c2674` no `vout` for input
      n: input.n,
      scriptPubkey: validScriptPubkeyFromAddress({
        address: input.addresses[0],
        coin: currencyInfo.network,
        network: args.network
      }),
      amount: input.value
    })),
    outputs: tx.vout.map(output => ({
      n: output.n,
      scriptPubkey:
        output.hex ??
        validScriptPubkeyFromAddress({
          address: output.addresses[0],
          coin: currencyInfo.network,
          network: args.network
        }),
      amount: output.value
    })),
    ourIns: [],
    ourOuts: [],
    ourAmount: '0'
  }
}

interface ProcessAddressUtxosArgs extends CommonArgs {
  processing: boolean
  path: ShortPath
  address: string
  uri: string
}

const processAddressUtxos = async (
  args: ProcessAddressUtxosArgs
): Promise<WsTask<IAccountUTXO[]>> => {
  const {
    address,
    walletTools,
    processor,
    taskCache,
    path,
    serverStates,
    uri
  } = args
  const { utxosCache, rawUtxosCache } = taskCache
  const queryTime = Date.now()
  const deferredIAccountUTXOs = new Deferred<IAccountUTXO[]>()
  deferredIAccountUTXOs.promise
    .then(async (utxos: IAccountUTXO[]) => {
      serverStates.serverScoreUp(uri, Date.now() - queryTime)
      const scriptPubkey = walletTools.addressToScriptPubkey(address)
      const addressData = await processor.fetchAddress(scriptPubkey)
      if (addressData == null || addressData.path == null) {
        return
      }
      for (const utxo of utxos) {
        rawUtxosCache[JSON.stringify(utxo)] = {
          processing: false,
          requiredCount: utxos.length,
          path,
          // TypeScript yells otherwise
          address: { ...addressData, path: addressData.path }
        }
      }
    })
    .catch(() => {
      args.processing = false
      utxosCache[address] = {
        processing: args.processing,
        path
      }
    })
  return {
    ...addressUtxosMessage(address),
    cleaner: asAddressUtxos,
    deferred: deferredIAccountUTXOs
  }
}

interface ProcessUtxoTransactionArgs extends CommonArgs {
  scriptPubkey: string
  utxos: Set<IUTXO>
  path: ShortPath
}

const processUtxoTransactions = async (
  args: ProcessUtxoTransactionArgs
): Promise<void> => {
  const { utxos, processor, scriptPubkey, log, emitter, currencyInfo } = args

  const currentUtxos = await processor.fetchUtxos({ scriptPubkey })
  const currentUtxoIds: string[] = []
  let oldBalance = '0'
  for (const utxo of currentUtxos) {
    if (utxo == null)
      throw new Error(
        'Unexpected undefined utxo when processing unspent transactions'
      )
    oldBalance = add(utxo.value, oldBalance)
    currentUtxoIds.push(utxo.txid)
  }
  await processor.removeUtxos(currentUtxoIds)

  let newBalance = '0'
  for (const utxo of Array.from(utxos)) {
    newBalance = add(utxo.value, newBalance)
    await processor.saveUtxo(utxo)
  }

  const diff = sub(newBalance, oldBalance)
  if (diff !== '0') {
    log('balance changed:', { scriptPubkey, diff })
    emitter.emit(
      EngineEvent.ADDRESS_BALANCE_CHANGED,
      currencyInfo.currencyCode,
      diff
    )

    // Update balances for address that have this scriptPubkey
    const address = await processor.fetchAddress(scriptPubkey)

    if (address == null) {
      throw new Error('address not found when processing UTXO transactions')
    }

    await processor.saveAddress({
      ...address,
      balance: newBalance,
      used: true
    })
  }
  setLookAhead(args, args.path).catch(err => {
    log.error(err)
    throw err
  })
}

interface ProcessRawUtxoArgs extends FormatArgs {
  path: ShortPath
  requiredCount: number
  utxo: IAccountUTXO
  id: string
  address: Required<IAddress>
  uri: string
}

const processRawUtxo = async (
  args: ProcessRawUtxoArgs
): Promise<WsTask<ITransaction> | undefined> => {
  const {
    utxo,
    id,
    address,
    format,
    walletTools,
    processor,
    path,
    taskCache,
    requiredCount,
    serverStates,
    uri,
    log
  } = args
  const { rawUtxosCache, processedUtxosCache } = taskCache
  let scriptType: ScriptTypeEnum
  let script: string
  let redeemScript: string | undefined

  // Function to call once we are finished
  const done = (): void =>
    addToProcessedUtxosCache(
      processedUtxosCache,
      path,
      address.scriptPubkey,
      requiredCount,
      {
        id,
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.value,
        scriptPubkey: address.scriptPubkey,
        script,
        redeemScript,
        scriptType,
        blockHeight: utxo.height ?? -1,
        spent: false
      }
    )

  switch (currencyFormatToPurposeType(format)) {
    case BIP43PurposeTypeEnum.Airbitz:
    case BIP43PurposeTypeEnum.Legacy:
      scriptType = ScriptTypeEnum.p2pkh

      // Legacy UTXOs need the previous transaction hex as the script
      // If we do not currently have it, add it to the queue to fetch it
      {
        const [tx] = await processor.fetchTransactions({ txId: utxo.txid })
        if (tx == null) {
          const queryTime = Date.now()
          const deferredITransaction = new Deferred<ITransaction>()
          deferredITransaction.promise
            .then((rawTx: ITransaction) => {
              serverStates.serverScoreUp(uri, Date.now() - queryTime)
              const processedTx = processRawTx({ ...args, tx: rawTx })
              script = processedTx.hex
              // Only after we have successfully fetched the tx, set our script and call done
              done()
            })
            .catch(e => {
              // If something went wrong, add the UTXO back to the queue
              log('error in processed utxos cache, re-adding utxo to cache:', e)
              rawUtxosCache[JSON.stringify(utxo)] = {
                processing: false,
                path,
                address,
                requiredCount
              }
            })
          return {
            ...transactionMessage(utxo.txid),
            deferred: deferredITransaction
          }
        } else {
          script = tx.hex
        }
      }

      break
    case BIP43PurposeTypeEnum.WrappedSegwit:
      scriptType = ScriptTypeEnum.p2wpkhp2sh
      script = address.scriptPubkey
      redeemScript = walletTools.getScriptPubkey(address.path).redeemScript

      break
    case BIP43PurposeTypeEnum.Segwit:
      scriptType = ScriptTypeEnum.p2wpkh
      script = address.scriptPubkey

      break
  }

  // Since we have everything, call done
  done()
}

const addToProcessedUtxosCache = (
  processedUtxosCache: ProcessedUtxoCache,
  path: ShortPath,
  scriptPubkey: string,
  requiredCount: number,
  utxo: IUTXO
): void => {
  const processedUtxos = processedUtxosCache[scriptPubkey] ?? {
    utxos: new Set(),
    processing: false,
    path,
    full: false
  }
  processedUtxos.utxos.add(utxo)
  processedUtxosCache[scriptPubkey] = processedUtxos
  processedUtxos.full = processedUtxos.utxos.size >= requiredCount
}

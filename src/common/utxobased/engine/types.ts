import { EdgeSpendInfo } from 'edge-core-js/types'

import { Input, Output } from '../keymanager/utxopicker/types'

export interface UtxoTxOtherParams {
  edgeSpendInfo?: EdgeSpendInfo
  ourScriptPubkeys: string[]
  psbt?: {
    base64: string
    inputs: Input[]
    outputs: Output[]
  }
  rbfTxid?: string
}

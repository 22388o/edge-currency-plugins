// Typescript translation from original code in edge-currency-bitcoin

import { asArray, asEither, asNull, asObject, asString } from 'cleaners'
import { Disklet } from 'disklet'
import { EdgeIo, EdgeLog } from 'edge-core-js/types'
import { makeMemlet } from 'memlet'

import { UtxoEngineState } from '../utxobased/engine/makeUtxoEngineState'
import { UtxoUserSettings } from '../utxobased/engine/types'
import { asServerInfoCache, ServerScores } from './serverScores'

// Info server endpoint to getting ServerListInfo data
const serverListInfoUrl = 'https://info1.edge.app/v1/blockBook/'
// The filename for ServerInfoCache data (see serverScores.ts)
// Perhaps this should be in serverScores.ts file, but that'll take some refactoring
const SERVER_CACHE_FILE = 'serverCache.json'

// ServerListInfo data structure from info server and saved to disk
const asServerListInfo = asObject(asEither(asArray(asString), asNull))

/** A JSON object (as opposed to an array or primitive). */
interface JsonObject {
  [name: string]: unknown
}

/**
 * This object holds the plugin-wide per-currency caches.
 * Engine plugins are responsible for keeping it up to date.
 */
export interface PluginStateSettings {
  io: EdgeIo
  defaultSettings: UtxoUserSettings
  currencyCode: string
  pluginId: string
  pluginDisklet: Disklet
  log: EdgeLog
}

export interface PluginState {
  addEngine: (engineState: UtxoEngineState) => void
  removeEngine: (engineState: UtxoEngineState) => void
  dumpData: () => JsonObject
  load: () => Promise<PluginState>
  serverScoreDown: (uri: string) => void
  serverScoreUp: (uri: string, score: number) => void
  clearCache: () => Promise<void>
  getLocalServers: (
    numServersWanted: number,
    includePatterns: string[]
  ) => string[]
  refreshServers: () => Promise<void>
  updateServers: (settings: UtxoUserSettings) => Promise<void>
}

export function makePluginState(settings: PluginStateSettings): PluginState {
  const {
    io,
    defaultSettings,
    currencyCode,
    pluginId,
    pluginDisklet,
    log
  } = settings
  let defaultServers = defaultSettings.blockbookServers
  let enableCustomServers = defaultSettings.enableCustomServers
  let engines: UtxoEngineState[] = []
  const memlet = makeMemlet(pluginDisklet)

  let serverCacheJson = {}
  let serverCacheDirty = false
  let servers = {}

  const saveServerCache = async (): Promise<void> => {
    serverScores.printServers(servers)
    if (serverCacheDirty) {
      await memlet.setJson(SERVER_CACHE_FILE, servers).catch(e => {
        log(`${pluginId} - ${JSON.stringify(e.toString())}`)
      })
      serverCacheDirty = false
      serverScores.scoresLastLoaded = Date.now()
      log(`${pluginId} - Saved server cache`)
    }
  }

  const onDirtyServer = (serverUrl: string): void => {
    serverCacheDirty = true
    for (const engine of engines) {
      if (engine.processedPercent === 1) {
        const isFound = engine.getServerList().includes(serverUrl)
        if (isFound) {
          saveServerCache().catch(e => {
            log(`${pluginId} - ${JSON.stringify(e.toString())}`)
          })
          // Early exit because the server cache is no longer dirty after
          // calling saveServerCache
          return
        }
      }
    }
  }

  const serverScores = new ServerScores({
    log,
    onDirtyServer
  })

  const fetchServers = async (): Promise<string[] | null> => {
    log(`${pluginId} - GET ${serverListInfoUrl}`)

    const response = await io.fetch(serverListInfoUrl)
    const responseBody = await (async () => {
      try {
        if (response.ok) {
          return await response.json()
        }
        log(
          `${pluginId} - Fetching ${serverListInfoUrl} failed with status ${response.status}`
        )
      } catch (err) {
        log(`${pluginId} - Fetching ${serverListInfoUrl} failed: ${err}`)
      }
      return {}
    })()

    const serverListInfo = asServerListInfo(responseBody)

    return serverListInfo[currencyCode] ?? null
  }

  const refreshServers = async (): Promise<void> => {
    let serverList = defaultServers

    if (!enableCustomServers)
      serverList = (await fetchServers()) ?? defaultServers

    serverScores.serverScoresLoad(servers, serverCacheJson, serverList)
    await saveServerCache()

    // Tell the engines about the new servers:
    for (const engine of engines) {
      engine.refillServers()
    }
  }

  return {
    /**
     * Begins notifying the engine of state changes. Used at connection time.
     */
    addEngine(engineState: UtxoEngineState): void {
      engines.push(engineState)
    },

    /**
     * Stops notifying the engine of state changes. Used at disconnection time.
     */
    removeEngine(engineState: UtxoEngineState): void {
      engines = engines.filter(engine => engine !== engineState)
    },

    dumpData(): JsonObject {
      return {
        'pluginState.servers_': servers
      }
    },

    async load(): Promise<PluginState> {
      try {
        serverCacheJson = asServerInfoCache(
          await memlet.getJson(SERVER_CACHE_FILE)
        )
      } catch (e) {
        log(`${pluginId}: Failed to load server cache: ${JSON.stringify(e)}`)
      }

      // Fetch servers in the background:
      refreshServers().catch(e => {
        log(`${pluginId} - ${JSON.stringify(e.toString())}`)
      })

      return this
    },

    serverScoreDown(uri: string): void {
      serverScores.serverScoreDown(servers, uri)
    },

    serverScoreUp(uri: string, score: number): void {
      serverScores.serverScoreUp(servers, uri, score)
    },

    async clearCache(): Promise<void> {
      serverScores.clearServerScoreTimes()
      servers = {}
      serverCacheDirty = true
      await memlet.delete(SERVER_CACHE_FILE)
    },

    getLocalServers(
      numServersWanted: number,
      includePatterns: string[] = []
    ): string[] {
      return serverScores.getServers(servers, numServersWanted, includePatterns)
    },

    refreshServers,

    async updateServers(settings: UtxoUserSettings): Promise<void> {
      enableCustomServers = settings.enableCustomServers
      defaultServers = settings.blockbookServers

      const enginesToBeStopped = []
      const disconnects = []
      for (const engine of engines) {
        enginesToBeStopped.push(engine)
        engine.setServerList([])
        disconnects.push(engine.stop())
      }
      await Promise.all(disconnects)
      serverScores.clearServerScoreTimes()
      serverCacheJson = {}
      serverCacheDirty = true
      await saveServerCache()
      await refreshServers()
      for (const engine of enginesToBeStopped) {
        await engine.stop()
      }
    }
  }
}

// Typescript translation from original code in edge-currency-bitcoin

import { asNumber, asObject, asString } from 'cleaners'
import { EdgeLog } from 'edge-core-js/types'

export type ServerInfo = ReturnType<typeof asServerInfo>
export const asServerInfo = asObject({
  serverUrl: asString,
  serverScore: asNumber,
  responseTime: asNumber,
  numResponseTimes: asNumber
})
export type ServerInfoCache = ReturnType<typeof asServerInfoCache>
export const asServerInfoCache = asObject(asServerInfo)

const RESPONSE_TIME_UNINITIALIZED = 999999999
const MAX_SCORE = 500
const MIN_SCORE = -100
const DROPPED_SERVER_SCORE = -100
const RE_ADDED_SERVER_SCORE = -10

interface ServerScoresOptions {
  log: EdgeLog
  onDirtyServer?: (serverUrl: string) => void
}

export class ServerScores {
  scoresLastLoaded: number
  log: EdgeLog
  lastScoreUpTime: number
  onDirtyServer: (serverUrl: string) => void

  constructor(options: ServerScoresOptions) {
    const { log, onDirtyServer = () => {} } = options
    this.log = log
    this.scoresLastLoaded = Date.now()
    this.lastScoreUpTime = Date.now()
    this.onDirtyServer = onDirtyServer
  }

  /**
   * Loads the server scores with new and old servers, mutates the passed in list of servers
   * @param oldServers: Map of ServerInfo objects by serverUrl. This should come from disk
   * @param newServers: Array<string> of new servers downloaded from the info server
   */
  serverScoresLoad(
    servers: ServerInfoCache,
    oldServers: { [serverUrl: string]: ServerInfo },
    newServers: string[] = []
  ): void {
    //
    // Add any new servers coming out of the info server
    //
    for (const newServer of newServers) {
      if (oldServers[newServer] === undefined) {
        const serverScoreObj: ServerInfo = {
          serverUrl: newServer,
          serverScore: 0,
          responseTime: RESPONSE_TIME_UNINITIALIZED,
          numResponseTimes: 0
        }
        oldServers[newServer] = serverScoreObj
      }
    }

    //
    // If there is a known server (oldServers) that is not on the newServers array, then set it's score to -1
    // to reduce chances of using it.
    //
    for (const serverUrl in oldServers) {
      const oldServer = oldServers[serverUrl]
      let match = false
      for (const newServerUrl of newServers) {
        if (newServerUrl === serverUrl) {
          match = true
          break
        }
      }

      let serverScore = oldServer.serverScore
      if (!match) {
        if (serverScore > DROPPED_SERVER_SCORE) {
          serverScore = DROPPED_SERVER_SCORE
        }
      } else {
        if (serverScore < RE_ADDED_SERVER_SCORE) {
          serverScore = RE_ADDED_SERVER_SCORE
        }
      }

      if (this.scoresLastLoaded === 0) {
        serverScore = Math.min(serverScore, MAX_SCORE - 100)
      }

      if (serverUrl.startsWith('ws') && serverScore > 0) {
        serverScore = 0
        oldServer.responseTime = RESPONSE_TIME_UNINITIALIZED
      }

      oldServer.serverScore = serverScore
      servers[serverUrl] = oldServer
      this.onDirtyServer(serverUrl)
    }
  }

  clearServerScoreTimes(): void {
    this.scoresLastLoaded = Date.now()
    this.lastScoreUpTime = Date.now()
  }

  printServers(servers: ServerInfoCache): void {
    this.log('**** printServers ****')
    const serverInfos: ServerInfo[] = []
    for (const s in servers) {
      serverInfos.push(servers[s])
    }
    // Sort by score
    serverInfos.sort((a: ServerInfo, b: ServerInfo) => {
      return b.serverScore - a.serverScore
    })

    for (const s of serverInfos) {
      const score = s.serverScore.toString()
      const response = s.responseTime.toString()
      const numResponse = s.numResponseTimes.toString()
      const url = s.serverUrl
      this.log(`ServerInfo ${score} ${response}ms ${numResponse} ${url}`)
    }
    this.log('**************************')
  }

  serverScoreUp(
    servers: ServerInfoCache,
    serverUrl: string,
    responseTimeMilliseconds: number,
    changeScore = 1
  ): void {
    const serverInfo: ServerInfo = servers[serverUrl]

    serverInfo.serverScore += changeScore
    if (serverInfo.serverScore > MAX_SCORE) {
      serverInfo.serverScore = MAX_SCORE
    }
    this.lastScoreUpTime = Date.now()

    if (responseTimeMilliseconds !== 0) {
      this.setResponseTime(servers, serverUrl, responseTimeMilliseconds)
    }

    this.log(
      `${serverUrl}: score UP to ${serverInfo.serverScore} ${responseTimeMilliseconds}ms`
    )
    this.onDirtyServer(serverUrl)
  }

  serverScoreDown(
    servers: ServerInfoCache,
    serverUrl: string,
    changeScore = 10
  ): void {
    const currentTime = Date.now()
    if (currentTime - this.lastScoreUpTime > 60000) {
      // It has been over 1 minute since we got an up-vote for any server.
      // Assume the network is down and don't penalize anyone for now
      this.log(`${serverUrl}: score DOWN cancelled`)
      return
    }
    const serverInfo: ServerInfo = servers[serverUrl]
    serverInfo.serverScore -= changeScore
    if (serverInfo.serverScore < MIN_SCORE) {
      serverInfo.serverScore = MIN_SCORE
    }

    if (serverInfo.numResponseTimes === 0) {
      this.setResponseTime(servers, serverUrl, 9999)
    }

    this.log(`${serverUrl}: score DOWN to ${serverInfo.serverScore}`)
    this.onDirtyServer(serverUrl)
  }

  setResponseTime(
    servers: ServerInfoCache,
    serverUrl: string,
    responseTimeMilliseconds: number
  ): void {
    const serverInfo: ServerInfo = servers[serverUrl]
    serverInfo.numResponseTimes++

    const oldTime = serverInfo.responseTime
    let newTime = 0
    if (RESPONSE_TIME_UNINITIALIZED === oldTime) {
      newTime = responseTimeMilliseconds
    } else {
      // Every 10th setting of response time, decrease effect of prior values by 5x
      if (serverInfo.numResponseTimes % 10 === 0) {
        newTime = (oldTime + responseTimeMilliseconds * 4) / 5
      } else {
        newTime = (oldTime + responseTimeMilliseconds) / 2
      }
    }
    serverInfo.responseTime = newTime
    this.onDirtyServer(serverUrl)
  }

  getServers(
    servers: ServerInfoCache,
    numServersWanted: number,
    includePatterns: string[] = []
  ): string[] {
    if (servers == null || Object.keys(servers).length === 0) {
      return []
    }

    let serverInfos: ServerInfo[] = []
    let newServerInfos: ServerInfo[] = []
    //
    // Find new servers from the passed in servers
    //
    for (const s in servers) {
      const server = servers[s]
      serverInfos.push(server)
      if (
        server.responseTime === RESPONSE_TIME_UNINITIALIZED &&
        server.serverScore === 0
      ) {
        newServerInfos.push(server)
      }
    }
    if (serverInfos.length === 0) {
      return []
    }
    if (includePatterns.length > 0) {
      const filter = (server: ServerInfo): boolean => {
        for (const pattern of includePatterns) {
          // make sure that the server URL starts with the required pattern
          if (server.serverUrl.indexOf(pattern) === 0) return true
        }
        return false
      }
      serverInfos = serverInfos.filter(filter)
      newServerInfos = newServerInfos.filter(filter)
    }
    // Sort by score
    serverInfos.sort((a: ServerInfo, b: ServerInfo) => {
      return b.serverScore - a.serverScore
    })

    //
    // Take the top 50% of servers that have
    // 1. A score within 100 points of the highest score
    // 2. And a positive score of at least 5
    // 3. And a response time that is not RESPONSE_TIME_UNINITIALIZED
    //
    // Then sort those top servers by response time from lowest to highest
    //

    const startServerInfo = serverInfos[0]
    let numServerPass = 0
    let serverEnd = 0
    for (let i = 0; i < serverInfos.length; i++) {
      const serverInfo = serverInfos[i]
      if (serverInfo.serverScore < startServerInfo.serverScore - 100) {
        continue
      }
      if (serverInfo.serverScore < 5) {
        continue
      }
      if (serverInfo.responseTime >= RESPONSE_TIME_UNINITIALIZED) {
        continue
      }
      numServerPass++
      if (numServerPass < numServersWanted) {
        continue
      }
      if (numServerPass >= serverInfos.length / 2) {
        continue
      }
      serverEnd = i
    }

    let topServerInfos = serverInfos.slice(0, serverEnd)
    topServerInfos.sort((a: ServerInfo, b: ServerInfo) => {
      return a.responseTime - b.responseTime
    })
    topServerInfos = topServerInfos.concat(serverInfos.slice(serverEnd))

    const selectedServers = []
    let numServers = 0
    let numNewServers = 0
    for (const serverInfo of topServerInfos) {
      numServers++
      selectedServers.push(serverInfo.serverUrl)
      if (
        serverInfo.responseTime === RESPONSE_TIME_UNINITIALIZED &&
        serverInfo.serverScore === 0
      ) {
        numNewServers++
      }

      if (numServers >= numServersWanted) {
        break
      }

      if (numServers >= numServersWanted / 2 && numNewServers === 0) {
        if (newServerInfos.length >= numServersWanted - numServers) {
          break
        }
      }
    }

    // If this list does not have a new server in it, try to add one as we always want to give new
    // servers a try.
    if (numNewServers === 0) {
      for (const serverInfo of newServerInfos) {
        selectedServers.unshift(serverInfo.serverUrl)
        numServers++
        if (numServers >= numServersWanted) {
          break
        }
      }
    }

    return selectedServers
  }
}

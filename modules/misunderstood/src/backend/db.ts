import * as sdk from 'botpress/sdk'
import Knex from 'knex'
import _, { get, pick } from 'lodash'
import moment from 'moment'
import Bluebird from 'bluebird'

import {
  DbFlaggedEvent,
  FilteringOptions,
  FlaggedEvent,
  FLAGGED_MESSAGE_STATUS,
  FLAGGED_MESSAGE_STATUSES,
  FLAG_REASON,
  ResolutionData,
  RESOLUTION_TYPE
} from '../types'

import { addQnA, addNLU, applyChanges } from './applyChanges'

export const TABLE_NAME = 'misunderstood'
export const EVENTS_TABLE_NAME = 'events'

export default class Db {
  knex: Knex & sdk.KnexExtension
  ghostForBot: (botId: string) => sdk.ScopedGhostService

  constructor(private bp: typeof sdk) {
    this.knex = bp.database
    this.ghostForBot = bp.ghost.forBot
  }

  async initialize() {
    await this.knex.createTableIfNotExists(TABLE_NAME, table => {
      table.increments('id')
      table.string('eventId')
      table.string('botId')
      table.string('language')
      table.text('preview')
      table.enum('reason', Object.values(FLAG_REASON))
      table.enum('status', FLAGGED_MESSAGE_STATUSES).defaultTo(FLAGGED_MESSAGE_STATUS.new)
      table.enum('resolutionType', Object.values(RESOLUTION_TYPE))
      table.string('resolution')
      table.json('resolutionParams')
      table.timestamp('createdAt').defaultTo(this.knex.fn.now())
      table.timestamp('updatedAt').defaultTo(this.knex.fn.now())
    })
  }

  async addEvent(event: FlaggedEvent) {
    const lookup = { botId: event.botId, language: event.language, preview: event.preview }
    const treatedEvents = await this.knex(TABLE_NAME)
      .count({ count: 'id' })
      .where(lookup)
      .andWhereNot({ status: FLAGGED_MESSAGE_STATUS.new })

    if (treatedEvents.length > 0 && treatedEvents[0].count > 0) {
      this.bp.logger.info(
        `Not inserting event with properies ${JSON.stringify(lookup)} as it has already been treated before`
      )
    } else {
      await this.knex(TABLE_NAME).insert(event)
    }
  }

  async deleteAll(botId: string, status: FLAGGED_MESSAGE_STATUS) {
    await this.knex(TABLE_NAME)
      .where({ botId, status })
      .del()
  }

  async updateStatuses(botId: string, ids: string[], status: FLAGGED_MESSAGE_STATUS, resolutionData?: ResolutionData) {
    if (status !== FLAGGED_MESSAGE_STATUS.pending) {
      resolutionData = { resolutionType: null, resolution: null, resolutionParams: null }
    } else {
      resolutionData = pick(resolutionData, 'resolutionType', 'resolution', 'resolutionParams')
    }

    await this.knex(TABLE_NAME)
      .where({ botId })
      .andWhere(function() {
        this.whereIn('id', ids)
      })
      .update({ status, ...resolutionData, updatedAt: this.knex.fn.now() })
  }

  async listEvents(
    botId: string,
    language: string,
    status: FLAGGED_MESSAGE_STATUS,
    options?: FilteringOptions
  ): Promise<DbFlaggedEvent[]> {
    const query = this.knex(TABLE_NAME)
      .select('*')
      .where({ botId, language, status })

    this.filterQuery(query, options)

    const data: DbFlaggedEvent[] = await query.orderBy('updatedAt', 'desc')

    return data.map((event: DbFlaggedEvent) => ({
      ...event,
      resolutionParams:
        event.resolutionParams && typeof event.resolutionParams !== 'object'
          ? JSON.parse(event.resolutionParams)
          : event.resolutionParams
    }))
  }

  async importData(botId: string, events: FlaggedEvent[]): Promise<void> {
    const botGhost = this.ghostForBot(botId)

    // Only deal with events that have a resolution defined. They can be null and pass the type check
    // because the type allows for un-resolved events, but we can't import those here
    events = events.filter(d => d.resolution && d.resolutionType)
    if (events.length === 0) {
      return
    }

    // sort intents and QnAs
    const [qnaEvents, nluEvents] = _.partition(events, { resolutionType: RESOLUTION_TYPE.qna })

    // Assert the intents and QnAs already exist
    const fileList = [
      ...(await botGhost.directoryListing('intents', '*.json')),
      ...(await botGhost.directoryListing('qna', '*.json'))
    ]
    let missing: Array<string> = []
    for (const event of events) {
      if (!fileList.includes(`${event.resolution}.json`)) {
        missing.push(event.resolution)
      }
    }
    if (missing.length) {
      throw new Error(`Bot is missing the following intents or QnAs: ${missing.join(', ')}`)
    }

    // import data into bot QnA / NLU
    await Bluebird.mapSeries(qnaEvents, async ev => addQnA(ev as DbFlaggedEvent, botGhost))
    await Bluebird.mapSeries(nluEvents, async ev => addNLU(ev as DbFlaggedEvent, botGhost))

    // import data into misunderstood DB
    // TODO: batch these writes. addEvent() does some extra checking that makes this possibly non-trivial
    for (let ev of events) {
      ev.botId = botId // overwrite the exported botId with the current botId
      await this.addEvent(ev)
    }

    return
  }

  async exportProcessedData(botId: string): Promise<FlaggedEvent[]> {
    // We don't care about created / updated at times or ID for export
    const appliedData: FlaggedEvent[] = await this.knex(TABLE_NAME)
      .where({ botId, status: FLAGGED_MESSAGE_STATUS.applied })
      .whereNotNull('resolution')
      .whereNotNull('resolutionType')
      .select([
        'eventId',
        'botId',
        'language',
        'preview',
        'reason',
        'status',
        'resolution',
        'resolutionType',
        'resolutionParams'
      ])

    return appliedData.map((event: FlaggedEvent) => ({
      ...event,
      resolutionParams:
        event.resolutionParams && typeof event.resolutionParams !== 'object'
          ? JSON.parse(event.resolutionParams)
          : event.resolutionParams
    }))
  }

  async countEvents(botId: string, language: string, options?: FilteringOptions) {
    const query = this.knex(TABLE_NAME)
      .where({ botId, language })
      .select('status')
      .count({ count: 'id' })

    this.filterQuery(query, options)

    const data: { status: string; count: number }[] = await query.groupBy('status')

    return data.reduce((acc, row) => {
      acc[row.status] = Number(row.count)
      return acc
    }, {})
  }

  async getEventDetails(botId: string, id: string) {
    const event = await this.knex(TABLE_NAME)
      .where({ botId, id })
      .limit(1)
      .select('*')
      .then((data: DbFlaggedEvent[]) => (data && data.length ? data[0] : null))

    if (!event) {
      return
    }

    const parentEvent = await this.knex(EVENTS_TABLE_NAME)
      .where({ botId, incomingEventId: event.eventId, direction: 'incoming' })
      .select('id', 'threadId', 'sessionId', 'event', 'createdOn')
      .limit(1)
      .first()

    if (!parentEvent) {
      return
    }

    const { threadId, sessionId, id: messageId, event: eventDetails, createdOn: messageCreatedOn } = parentEvent

    // SQLite will return dates as strings.
    // Since this.knex.date.[isAfter() | isBeforeOrOn()] expect strings to be colum names,
    // I wrap the timestamp string to a Date
    const messageCreatedOnAsDate = moment(messageCreatedOn).toDate()

    const messagesBefore = await this.knex(EVENTS_TABLE_NAME)
      .where({ botId, threadId, sessionId })
      .andWhere(this.knex.date.isBeforeOrOn('createdOn', messageCreatedOnAsDate))
      // Two events with different id can have same createdOn
      .orderBy([
        { column: 'createdOn', order: 'desc' },
        { column: 'id', order: 'desc' }
      ])
      .limit(6) // More messages displayed before can help user understand conversation better
      .select('id', 'event', 'createdOn')
    const messagesAfter = await this.knex(EVENTS_TABLE_NAME)
      .where({ botId, threadId, sessionId })
      .andWhere(this.knex.date.isAfter('createdOn', messageCreatedOnAsDate))
      .orderBy([
        { column: 'createdOn', order: 'asc' },
        { column: 'id', order: 'asc' }
      ])
      .limit(3)
      .select('id', 'event', 'createdOn')

    const context = _.chain([...messagesBefore, ...messagesAfter])
      .sortBy(['createdOn', 'id'])
      .map(({ id, event }) => {
        const eventObj = typeof event === 'string' ? JSON.parse(event) : event
        return {
          direction: eventObj.direction,
          preview: (eventObj.preview || '').replace(/<[^>]*>?/gm, ''),
          payloadMessage: get(eventObj, 'payload.message'),
          isCurrent: id === messageId
        }
      })
      .value()

    const parsedEventDetails =
      eventDetails && typeof eventDetails !== 'object' ? JSON.parse(eventDetails) : eventDetails

    return {
      ...event,
      resolutionParams:
        event.resolutionParams && typeof event.resolutionParams !== 'object'
          ? JSON.parse(event.resolutionParams)
          : event.resolutionParams,
      context,
      nluContexts: (parsedEventDetails && parsedEventDetails.nlu && parsedEventDetails.nlu.includedContexts) || []
    }
  }

  applyChanges(botId: string) {
    return applyChanges(this.bp, botId, TABLE_NAME)
  }

  filterQuery(query, options?: FilteringOptions) {
    const { startDate, endDate, reason } = options || {}

    if (startDate && endDate) {
      query.andWhere(this.knex.date.isBetween('updatedAt', startDate, endDate))
    }

    if (reason === 'thumbs_down') {
      query.andWhere({ reason })
    } else if (reason && reason !== 'thumbs_down') {
      query.andWhereNot('reason', 'thumbs_down')
    }
  }
}

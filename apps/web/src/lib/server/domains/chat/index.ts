/**
 * Live chat domain module exports.
 *
 * IMPORTANT: This barrel only re-exports types. Service/query functions that
 * touch the database are NOT exported here so they never get bundled into the
 * client. Import them directly from './chat.service' / './chat.query' in
 * server-only code (server functions, API routes).
 */
export type {
  ChatAuthorInput,
  SendVisitorMessageInput,
  SendVisitorMessageResult,
  SendAgentMessageResult,
} from './chat.types'

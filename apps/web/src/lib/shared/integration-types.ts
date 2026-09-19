/**
 * Client-safe integration types and constants.
 * Re-exported from lib/server/integrations/types for use in client components.
 * Only plain types/interfaces and value objects with no server-only dependencies live here.
 */

export type {
  PreAuthField,
  PlatformCredentialField,
  IntegrationOAuthConfig,
} from '@/lib/server/integrations/types'
export { INTEGRATION_CATEGORIES } from '@/lib/server/integrations/types'
export type {
  IntegrationCategory,
  IntegrationCapability,
  IntegrationCatalogEntry,
} from '@/lib/server/integrations/types'

/**
 * Azure DevOps project and work item type shapes.
 * Kept here so client components don't need to import the full api module.
 */
export interface AzureDevOpsProject {
  id: string
  name: string
}

export interface AzureDevOpsWorkItemType {
  name: string
  description: string
}

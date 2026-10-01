import logger from '../utils/logger';
import { IProvider } from '../providers/interfaces/IProvider';
import { RoutingContext } from '../types';

export class Router {
  /**
   * Route a job to the most appropriate provider based on capabilities and constraints
   */
  async route(
    type: string,
    providers: IProvider[],
    context?: RoutingContext,
  ): Promise<{ providerName: string; reasoning: string; fallbackProviders?: string[] }> {
    // Filter providers that support this capability
    const capable = providers.filter((candidate) =>
      candidate.capabilities.includes(type),
    );

    if (!capable.length) {
      throw new Error(`No provider available for ${type}`);
    }

    // Single provider case
    if (capable.length === 1) {
      const provider = capable[0];
      logger.info(`[Router] Selected provider ${provider.name} for ${type} (only available)`);
      return {
        providerName: provider.name,
        reasoning: `Only available provider for ${type}`,
      };
    }

    // Check user preference if provided
    if (context?.userPreferences?.defaultProvider) {
      const preferred = capable.find(
        (p) => p.name === context.userPreferences?.defaultProvider,
      );
      if (preferred) {
        logger.info(
          `[Router] Selected provider ${preferred.name} for ${type} (user preference)`,
        );
        return {
          providerName: preferred.name,
          reasoning: `Selected by user preference: ${preferred.name}`,
          fallbackProviders: capable
            .filter((p) => p !== preferred)
            .map((p) => p.name),
        };
      }
    }

    // Check provider health
    const healthyProviders: IProvider[] = [];
    for (const provider of capable) {
      try {
        const healthy = await provider.healthCheck();
        if (healthy) {
          healthyProviders.push(provider);
        } else {
          logger.info(`[Router] Provider ${provider.name} health check failed`);
        }
      } catch (error) {
        logger.warn(`[Router] Provider ${provider.name} health check error`, error);
      }
    }

    // Use healthy providers if available, otherwise fall back to all capable
    const selectedFrom = healthyProviders.length > 0 ? healthyProviders : capable;
    const selected = selectedFrom[0];

    logger.info(
      `[Router] Selected provider ${selected.name} for ${type} (${healthyProviders.length > 0 ? 'healthy' : 'all capable'})`,
    );

    return {
      providerName: selected.name,
      reasoning: `Selected by availability and priority`,
      fallbackProviders: selectedFrom.slice(1).map((p) => p.name),
    };
  }
}

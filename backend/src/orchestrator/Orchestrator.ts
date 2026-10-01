import { v4 as uuidv4 } from 'uuid';
import { IJob, JobStatus, JobType, JobPriority, UserPreferences } from '../types';
import { IProvider } from '../providers/interfaces/IProvider';
import { Router } from '../routing/Router';
import { Job as JobModel } from '../database/models';
import logger from '../utils/logger';
import { AppError, ValidationError } from '../types/errors';

export interface OrchestratorRequest {
  userId: string;
  jobType: JobType;
  input: Record<string, any>;
  priority?: JobPriority;
  webhookUrl?: string;
  userPreferences?: UserPreferences;
}

export interface OrchestratorResponse {
  jobId: string;
  status: JobStatus;
  createdAt: Date;
}

export class Orchestrator {
  private router = new Router();
  private providers = new Map<string, IProvider>();

  /**
   * Register an AI provider with the orchestrator
   */
  registerProvider(provider: IProvider): void {
    this.providers.set(provider.name.toLowerCase(), provider);
    logger.info(`[Orchestrator] Registered provider: ${provider.name}`);
  }

  /**
   * Get all available providers
   */
  getAvailableProviders(): IProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Get a specific provider by name
   */
  getProvider(name: string): IProvider | undefined {
    return this.providers.get(name.toLowerCase());
  }

  /**
   * Create a new job and enqueue it for processing
   */
  async createJob(request: OrchestratorRequest): Promise<OrchestratorResponse> {
    if (
      !request.userId ||
      !request.jobType ||
      !request.input ||
      !Object.keys(request.input).length
    ) {
      throw new ValidationError(
        'User, job type and input are required',
      );
    }

    const providers = this.getAvailableProviders();
    if (!providers.length) {
      throw new AppError(
        'NO_PROVIDERS',
        'No AI providers are currently available',
        503,
      );
    }

    const decision = await this.router.route(request.jobType, providers, {
      jobType: request.jobType,
      capabilities: [request.jobType as any],
      userPreferences: request.userPreferences,
    });

    const job = await JobModel.create({
      _id: uuidv4(),
      userId: request.userId,
      type: request.jobType,
      status: JobStatus.QUEUED,
      priority: request.priority || JobPriority.NORMAL,
      input: request.input,
      metadata: {
        requestedAt: new Date(),
        retryCount: 0,
        maxRetries: 3,
        provider: decision.providerName,
      },
      webhookUrl: request.webhookUrl,
    });

    logger.info(
      `[Orchestrator] Job created: ${job.id} (type: ${request.jobType}, provider: ${decision.providerName})`,
    );

    return {
      jobId: job.id as string,
      status: job.status as JobStatus,
      createdAt: job.createdAt,
    };
  }

  /**
   * Execute a job asynchronously
   */
  async executeJob(jobId: string): Promise<void> {
    const job = await JobModel.findById(jobId);
    if (!job) {
      throw new AppError('JOB_NOT_FOUND', 'Job not found', 404);
    }

    const providerName = String(job.metadata?.provider || '').toLowerCase();
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new AppError('PROVIDER_NOT_FOUND', 'Provider not found', 503);
    }

    try {
      // Update job status to processing
      job.status = JobStatus.PROCESSING;
      job.progress = { percentage: 10, stage: 'started' };
      job.metadata.startedAt = new Date();
      await job.save();
      logger.info(`[Orchestrator] Processing job: ${jobId}`);

      // Validate input with provider
      const validation = await provider.validateInput(job.type, job.input);
      if (!validation.valid) {
        throw new ValidationError(
          `Invalid input for ${job.type}`,
          { errors: validation.errors },
        );
      }

      job.progress = { percentage: 20, stage: 'validated' };
      await job.save();

      // Execute task based on job type
      let output: any;
      switch (job.type) {
        case JobType.IMAGE_GENERATION:
          job.progress = { percentage: 30, stage: 'generating_image' };
          await job.save();
          output = await provider.generateImage(job.input as any);
          break;

        case JobType.VIDEO_GENERATION:
          job.progress = { percentage: 30, stage: 'generating_video' };
          await job.save();
          output = await provider.generateVideo(job.input as any);
          break;

        case JobType.AUDIO_GENERATION:
          job.progress = { percentage: 30, stage: 'generating_audio' };
          await job.save();
          output = await provider.generateAudio(job.input as any);
          break;

        case JobType.TEXT_TO_SPEECH:
          job.progress = { percentage: 30, stage: 'synthesizing_speech' };
          await job.save();
          output = await provider.synthesizeSpeech(job.input as any);
          break;

        default:
          throw new Error(`Unsupported job type: ${job.type}`);
      }

      // Update job with result
      job.status = JobStatus.COMPLETED;
      job.progress = { percentage: 100, stage: 'completed' };
      job.output = output;
      job.result = {
        contentUrl: output.url,
        format: output.format,
        size: output.size || 0,
        duration: output.duration,
        metadata: output.metadata,
      };
      job.metadata.completedAt = new Date();
      job.metadata.executionTime =
        job.metadata.completedAt.getTime() -
        (job.metadata.startedAt?.getTime() || 0);

      await job.save();
      logger.info(
        `[Orchestrator] Job completed: ${jobId} (execution time: ${job.metadata.executionTime}ms)`,
      );
    } catch (error) {
      // Handle execution error with retry logic
      const shouldRetry =
        (job.metadata.retryCount || 0) <
        (job.metadata.maxRetries || 3);

      job.status = shouldRetry ? JobStatus.QUEUED : JobStatus.FAILED;
      job.metadata.retryCount = (job.metadata.retryCount || 0) + 1;
      job.error = {
        code: 'EXECUTION_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      };

      await job.save();

      const action = shouldRetry
        ? `queued for retry (${job.metadata.retryCount}/${job.metadata.maxRetries})`
        : 'marked as failed';
      logger.error(
        `[Orchestrator] Job execution failed: ${jobId} - ${action}`,
        error,
      );
    }
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string): Promise<IJob> {
    const job = await JobModel.findById(jobId);
    if (!job) {
      throw new AppError('JOB_NOT_FOUND', 'Job not found', 404);
    }
    return job as IJob;
  }

  /**
   * Cancel a job
   */
  async cancelJob(jobId: string): Promise<void> {
    const job = await JobModel.findById(jobId);
    if (!job) {
      throw new AppError('JOB_NOT_FOUND', 'Job not found', 404);
    }

    if (
      [JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED].includes(
        job.status as JobStatus,
      )
    ) {
      throw new AppError(
        'INVALID_JOB_STATE',
        `Cannot cancel job in status: ${job.status}`,
        400,
      );
    }

    job.status = JobStatus.CANCELLED;
    job.metadata.completedAt = new Date();
    await job.save();

    logger.info(`[Orchestrator] Job cancelled: ${jobId}`);
  }
}

export default new Orchestrator();

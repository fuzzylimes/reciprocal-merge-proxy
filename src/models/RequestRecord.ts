// Possible request states
export enum requestStatus {
  queued = "queued",
  inProgress = "in-progress",
  complete = "complete"
}

// Interface for DynamoDB record
export interface RequestRecord {
  requestId: string;
  status: requestStatus;
  s3Key?: string; // S3 key where response data is stored
  cookie: string;
  dea: string;
  createdAt: number;
  ttl: number;
}

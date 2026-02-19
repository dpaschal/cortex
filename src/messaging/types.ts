export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  type: 'info' | 'question' | 'task' | 'response' | 'error';
  status: 'new' | 'read' | 'archived';
  timestamp: string;
  threadId?: string;
  context?: {
    project?: string;
    priority?: 'normal' | 'high' | 'urgent';
  };
}

export interface WriteMessageInput {
  from: string;
  to: string;
  content: string;
  type: 'info' | 'question' | 'task' | 'response' | 'error';
  threadId?: string;
  context?: {
    project?: string;
    priority?: 'normal' | 'high' | 'urgent';
  };
}

export interface ChannelMessage {
  channelType: 'discord' | 'telegram';
  channelId: string;
  userId: string;
  username: string;
  content: string;
  timestamp: string;
  replyTo?: string;
}

export interface ChannelAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onMessage(handler: (message: ChannelMessage) => void): void;
  sendMessage(channelId: string, content: string, replyTo?: string): Promise<void>;
}

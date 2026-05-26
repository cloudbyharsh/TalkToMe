-- Create connect_request table (primary way to initiate a conversation).
-- User A sends a request with an optional intro message; User B accepts or rejects.
-- On acceptance a handoffConnection is created and both users move to in_conversation.
-- Requests expire after 10 minutes if not acted on.
CREATE TABLE `connect_request` (
  `id` text PRIMARY KEY NOT NULL,
  `requester_user_id` text NOT NULL,
  `recipient_user_id` text NOT NULL,
  `place_id` text NOT NULL,
  `intro_message` text,
  `status` text NOT NULL DEFAULT 'pending',
  `expires_at` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`requester_user_id`) REFERENCES `user`(`id`) ON DELETE cascade,
  FOREIGN KEY (`recipient_user_id`) REFERENCES `user`(`id`) ON DELETE cascade,
  FOREIGN KEY (`place_id`) REFERENCES `place`(`place_id`) ON DELETE cascade
);

CREATE INDEX `connect_request_requester_idx` ON `connect_request` (`requester_user_id`);
CREATE INDEX `connect_request_recipient_idx` ON `connect_request` (`recipient_user_id`);
CREATE INDEX `connect_request_place_idx` ON `connect_request` (`place_id`);

-- Pre-conversation message thread attached to a connect request.
-- max 3 messages per sender per request; body <= 240 chars; pending requests only.
CREATE TABLE `connect_request_message` (
  `id` text PRIMARY KEY NOT NULL,
  `request_id` text NOT NULL,
  `sender_user_id` text NOT NULL,
  `body` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`request_id`) REFERENCES `connect_request`(`id`) ON DELETE cascade,
  FOREIGN KEY (`sender_user_id`) REFERENCES `user`(`id`) ON DELETE cascade
);

CREATE INDEX `crm_request_idx` ON `connect_request_message` (`request_id`);
CREATE INDEX `crm_sender_idx` ON `connect_request_message` (`sender_user_id`);

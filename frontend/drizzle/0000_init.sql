CREATE TABLE `agent_spend` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`castle_id` text NOT NULL,
	`siege_id` text,
	`amount_tinybar` integer NOT NULL,
	`day` text NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_spend_agent_idx` ON `agent_spend` (`agent_id`);--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`castle_id` text NOT NULL,
	`siege_id` text,
	`reason` text NOT NULL,
	`reasoning` text NOT NULL,
	`amount_tinybar` integer NOT NULL,
	`pressure` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`consumed` integer DEFAULT false NOT NULL,
	`top_up_tx` text,
	`created_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` text NOT NULL,
	`castle_id` text,
	`siege_id` text,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`seq` integer,
	`tx_id` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `castles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`guardian_name` text NOT NULL,
	`title` text DEFAULT 'Recruit' NOT NULL,
	`personality` text DEFAULT 'stern' NOT NULL,
	`tier` text NOT NULL,
	`orders` text NOT NULL,
	`fee_tinybar` integer NOT NULL,
	`pot_tinybar` integer NOT NULL,
	`asset` text DEFAULT '0.0.0' NOT NULL,
	`streak` integer DEFAULT 0 NOT NULL,
	`siege_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`owner` text NOT NULL,
	`vault_id` integer,
	`create_vault_tx` text,
	`topic_id` text,
	`deadline` integer NOT NULL,
	`portrait_url` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`siege_id` text DEFAULT '' NOT NULL,
	`castle_id` text,
	`type` text NOT NULL,
	`turn` integer,
	`payload` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_siege_idx` ON `events` (`siege_id`);--> statement-breakpoint
CREATE TABLE `free_sieges` (
	`wallet` text NOT NULL,
	`day` text NOT NULL,
	`siege_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `free_sieges_wallet_day` ON `free_sieges` (`wallet`,`day`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`siege_id` text NOT NULL,
	`turn` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`move` text,
	`request_id` text,
	`tool_calls` text,
	`exposed` text,
	`pressure` integer,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_siege_idx` ON `messages` (`siege_id`);--> statement-breakpoint
CREATE TABLE `payment_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`siege_id` text,
	`payer` text NOT NULL,
	`amount_tinybar` integer NOT NULL,
	`asset` text NOT NULL,
	`tx_id` text,
	`network` text,
	`hashscan_url` text,
	`free` integer DEFAULT false NOT NULL,
	`stub` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raider_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`strategy` text NOT NULL,
	`account_id` text NOT NULL,
	`evm_address` text,
	`private_key` text,
	`budget_tinybar` integer NOT NULL,
	`spent_tinybar` integer DEFAULT 0 NOT NULL,
	`per_castle_cap_tinybar` integer NOT NULL,
	`daily_cap_tinybar` integer NOT NULL,
	`stop_after_losses` integer DEFAULT 10 NOT NULL,
	`consecutive_losses` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sieges` (
	`id` text PRIMARY KEY NOT NULL,
	`castle_id` text NOT NULL,
	`raider` text NOT NULL,
	`agent_id` text,
	`free` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`turn` integer DEFAULT 0 NOT NULL,
	`receipt_id` text,
	`transcript_hash` text,
	`attempt_tx` text,
	`release_tx` text,
	`release_amount_tinybar` integer,
	`chain_error` text,
	`chain_attempts` integer DEFAULT 0 NOT NULL,
	`max_pressure` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE INDEX `sieges_castle_idx` ON `sieges` (`castle_id`);--> statement-breakpoint
CREATE INDEX `sieges_status_idx` ON `sieges` (`status`);
CREATE TABLE `proxy_records` (
	`request_id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`siege_id` text,
	`turn` integer,
	`prompt_hash` text NOT NULL,
	`protected_tool_called` integer DEFAULT false NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proxy_records_siege_idx` ON `proxy_records` (`siege_id`);--> statement-breakpoint
ALTER TABLE `castles` ADD `protected_tool` text DEFAULT 'unlock_vault' NOT NULL;--> statement-breakpoint
ALTER TABLE `castles` ADD `vault_state` text DEFAULT 'created' NOT NULL;--> statement-breakpoint
ALTER TABLE `castles` ADD `vault_state_reason` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `transport` text DEFAULT 'hosted' NOT NULL;--> statement-breakpoint
ALTER TABLE `castles` ADD `last_seen_at` text;--> statement-breakpoint
ALTER TABLE `sieges` ADD `transport` text DEFAULT 'hosted' NOT NULL;--> statement-breakpoint
UPDATE `castles` SET `vault_state` = CASE `status` WHEN 'open' THEN 'guarding' WHEN 'broken' THEN 'broken' ELSE 'closed' END;

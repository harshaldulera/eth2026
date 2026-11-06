CREATE TABLE `proxy_records` (
	`request_id` text PRIMARY KEY NOT NULL,
	`castle_id` text NOT NULL,
	`siege_id` text,
	`turn` integer,
	`model` text NOT NULL,
	`prompt_hash` text NOT NULL,
	`response_hash` text NOT NULL,
	`protected_tool_called` integer NOT NULL,
	`tool_calls` text NOT NULL,
	`cost_usd_micro` text,
	`mock` integer DEFAULT false NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proxy_records_siege_idx` ON `proxy_records` (`siege_id`);
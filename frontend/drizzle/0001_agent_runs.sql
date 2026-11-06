CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`castle_id` text NOT NULL,
	`max_sieges` integer NOT NULL,
	`sieges_run` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`stop_reason` text,
	`created_at` text NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE INDEX `agent_runs_agent_idx` ON `agent_runs` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_status_idx` ON `agent_runs` (`status`);--> statement-breakpoint
ALTER TABLE `sieges` ADD `settled_at` text;
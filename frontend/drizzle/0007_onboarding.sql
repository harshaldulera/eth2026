-- 0007_onboarding (plans/siege-onboarding-plan.md §0): publish/deposit/SDK-guard/unit onboarding.
-- Every new castles/raider_agents column is nullable or defaulted, so seeded fixtures and existing rows keep working.
-- Keys: owner_key_hash / operator_key_hash are sha256 hex; guard_key / vault_key / zg_* are raw at rest and never returned by any API.
CREATE TABLE `deposit_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`code` text NOT NULL,
	`memo` text NOT NULL,
	`amount_tinybar` integer NOT NULL,
	`payer_filter` text,
	`state` text DEFAULT 'awaiting' NOT NULL,
	`received_tinybar` integer DEFAULT 0 NOT NULL,
	`txs` text DEFAULT '[]' NOT NULL,
	`payer` text,
	`note` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`funded_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deposit_intents_code` ON `deposit_intents` (`code`);--> statement-breakpoint
CREATE INDEX `deposit_intents_state_idx` ON `deposit_intents` (`state`);--> statement-breakpoint
CREATE TABLE `guard_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`castle_id` text NOT NULL,
	`kind` text NOT NULL,
	`siege_id` text,
	`turn` integer,
	`messages_json` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`lease_id` text,
	`reply_json` text,
	`request_id` text,
	`claimed_at` text,
	`answered_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `guard_turns_castle_state_idx` ON `guard_turns` (`castle_id`,`state`);--> statement-breakpoint
CREATE TABLE `operators` (
	`account` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operators_handle` ON `operators` (`handle`);--> statement-breakpoint
CREATE TABLE `unit_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`name` text NOT NULL,
	`strategy` text NOT NULL,
	`strategy_text` text,
	`budget_tinybar` integer NOT NULL,
	`per_castle_cap_tinybar` integer NOT NULL,
	`daily_cap_tinybar` integer NOT NULL,
	`stop_after_losses` integer DEFAULT 10 NOT NULL,
	`operator_key_hash` text NOT NULL,
	`zg_api_key` text,
	`zg_mgmt_key` text,
	`zg_key_id` text,
	`state` text DEFAULT 'awaiting' NOT NULL,
	`agent_id` text,
	`error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vault_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`castle_id` text NOT NULL,
	`intent_id` text NOT NULL,
	`form` text NOT NULL,
	`owner_key_hash` text NOT NULL,
	`fee_tinybar` integer NOT NULL,
	`days` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vault_drafts_castle_id` ON `vault_drafts` (`castle_id`);--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `deposit_intent_id` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `published` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `castles` ADD `blurb` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `tools` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `owner_key_hash` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `deposit_tx` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `zg_api_key` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `zg_mgmt_key` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `zg_key_id` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `guard_key` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `vault_key` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `lease_id` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `lease_meta` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `pinned_prompt_hash` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `prompt_drift_hash` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `self_check_at` text;--> statement-breakpoint
ALTER TABLE `castles` ADD `smoke_result` text;--> statement-breakpoint
CREATE UNIQUE INDEX `castles_guard_key` ON `castles` (`guard_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `castles_vault_key` ON `castles` (`vault_key`);--> statement-breakpoint
ALTER TABLE `proxy_records` ADD `billed_to` text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE `raider_agents` ADD `operator_key_hash` text;--> statement-breakpoint
ALTER TABLE `raider_agents` ADD `strategy_text` text;--> statement-breakpoint
ALTER TABLE `raider_agents` ADD `funded_by` text DEFAULT 'arena' NOT NULL;--> statement-breakpoint
ALTER TABLE `raider_agents` ADD `deposit_tx` text;--> statement-breakpoint
ALTER TABLE `raider_agents` ADD `zg_api_key` text;--> statement-breakpoint
ALTER TABLE `raider_agents` ADD `zg_mgmt_key` text;--> statement-breakpoint
ALTER TABLE `raider_agents` ADD `zg_key_id` text;--> statement-breakpoint
ALTER TABLE `sieges` ADD `turn_token_hash` text;
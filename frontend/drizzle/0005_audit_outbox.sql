CREATE TABLE `audit_meta` (
	`k` text PRIMARY KEY NOT NULL,
	`v` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `audit_log` ADD `local_seq` integer;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `event_id` integer;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `submitted_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_topic_local_seq` ON `audit_log` (`topic_id`,`local_seq`) WHERE "audit_log"."local_seq" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_event_id` ON `audit_log` (`event_id`) WHERE "audit_log"."event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `audit_log_state_idx` ON `audit_log` (`state`,`topic_id`);--> statement-breakpoint
CREATE INDEX `audit_log_castle_idx` ON `audit_log` (`castle_id`);--> statement-breakpoint
-- Rows written before the outbox were submitted inline: the ones with an HCS seq are on the topic, the
-- rest failed (or had no topic) and are never re-sent, so they cannot land out of order.
UPDATE `audit_log` SET `state` = CASE WHEN `seq` IS NOT NULL THEN 'submitted' ELSE 'skipped' END;--> statement-breakpoint
UPDATE `audit_log` SET `local_seq` = (SELECT COUNT(*) FROM `audit_log` AS `a` WHERE `a`.`topic_id` = `audit_log`.`topic_id` AND `a`.`id` <= `audit_log`.`id`);--> statement-breakpoint
-- siege.start / siege.message / siege.end are now derived from the events table; events already on
-- the old inline path were audited then, so derivation starts after the newest existing event.
INSERT INTO `audit_meta` (`k`, `v`) SELECT 'events_cursor', CAST(COALESCE(MAX(`id`), 0) AS TEXT) FROM `events`;

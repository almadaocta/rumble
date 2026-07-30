CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` text NOT NULL,
	`source` text DEFAULT 'wahoo' NOT NULL,
	`external_id` text,
	`type` text NOT NULL,
	`name` text,
	`started_at` integer NOT NULL,
	`duration_s` integer NOT NULL,
	`distance_m` real,
	`avg_power` integer,
	`norm_power` integer,
	`max_power` integer,
	`avg_hr` integer,
	`max_hr` integer,
	`avg_cadence` integer,
	`elevation_m` real,
	`calories` integer,
	`tss` real,
	`intensity_factor` real,
	`fit_file_url` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_activities_date` ON `activities` (`athlete_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `activities_athlete_id_source_external_id_unique` ON `activities` (`athlete_id`,`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `activity_laps` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`lap_index` integer NOT NULL,
	`started_at` integer NOT NULL,
	`duration_s` integer NOT NULL,
	`distance_m` real,
	`avg_power` integer,
	`max_power` integer,
	`norm_power` integer,
	`avg_hr` integer,
	`max_hr` integer,
	`avg_cadence` integer,
	`avg_speed` real,
	`elevation_gain` real,
	`calories` integer,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_laps_activity` ON `activity_laps` (`activity_id`,`lap_index`);--> statement-breakpoint
CREATE TABLE `activity_streams` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`timestamps` text,
	`power` text,
	`heart_rate` text,
	`cadence` text,
	`speed` text,
	`altitude` text,
	`distance` text,
	`temperature` text,
	`lat` text,
	`lng` text,
	`sample_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_streams_activity_id_unique` ON `activity_streams` (`activity_id`);--> statement-breakpoint
CREATE TABLE `athletes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`timezone` text DEFAULT 'Europe/Madrid' NOT NULL,
	`ftp` integer,
	`ftp_updated_at` integer,
	`weight_kg` real,
	`height_cm` integer,
	`age` integer,
	`sex` text,
	`available_hours_week` real,
	`experience_level` text,
	`primary_goal` text,
	`coaching_tone` integer DEFAULT 5 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_chat` ON `chat_messages` (`chat_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` text NOT NULL,
	`title` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `coaching_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` text NOT NULL,
	`category` text DEFAULT 'general' NOT NULL,
	`content` text NOT NULL,
	`expires_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_notes_athlete` ON `coaching_notes` (`athlete_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `daily_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` text NOT NULL,
	`date` text NOT NULL,
	`daily_tss` real DEFAULT 0 NOT NULL,
	`ctl` real,
	`atl` real,
	`tsb` real,
	`ramp_rate` real,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_metrics_date` ON `daily_metrics` (`athlete_id`,`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `daily_metrics_athlete_id_date_unique` ON `daily_metrics` (`athlete_id`,`date`);--> statement-breakpoint
CREATE TABLE `kb_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`vertical` text NOT NULL,
	`source_file` text NOT NULL,
	`chunk_text` text NOT NULL,
	`embedding` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chunks_vertical` ON `kb_chunks` (`vertical`);--> statement-breakpoint
CREATE TABLE `knowledge_gaps` (
	`id` text PRIMARY KEY NOT NULL,
	`specialist` text NOT NULL,
	`topic` text NOT NULL,
	`query` text NOT NULL,
	`times_hit` integer DEFAULT 1 NOT NULL,
	`first_seen` integer DEFAULT (unixepoch()) NOT NULL,
	`last_seen` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nutrition_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` text NOT NULL,
	`date` text NOT NULL,
	`logged_at` integer DEFAULT (unixepoch()) NOT NULL,
	`meal_type` text,
	`confidence_tier` integer DEFAULT 3 NOT NULL,
	`description` text NOT NULL,
	`calories` real,
	`carbs_g` real,
	`protein_g` real,
	`fat_g` real,
	`source` text DEFAULT 'chat',
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_nutrition_date` ON `nutrition_logs` (`athlete_id`,`date`);--> statement-breakpoint
CREATE TABLE `personal_bests` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` text NOT NULL,
	`best_1s` integer,
	`best_3s` integer,
	`best_10s` integer,
	`best_30s` integer,
	`best_1min` integer,
	`best_5min` integer,
	`best_10min` integer,
	`best_15min` integer,
	`best_20min` integer,
	`best_30min` integer,
	`best_1hr` integer,
	`best_2hr` integer,
	`max_hr` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_bests_athlete_id_unique` ON `personal_bests` (`athlete_id`);--> statement-breakpoint
CREATE TABLE `plan_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`athlete_id` text NOT NULL,
	`scheduled_date` text NOT NULL,
	`session_type` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`target_tss` integer,
	`target_duration_min` integer,
	`target_if` real,
	`intervals` text,
	`completed` integer DEFAULT false,
	`activity_id` text,
	`feedback_rpe` integer,
	`feedback_notes` text,
	`wahoo_plan_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `training_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_date` ON `plan_sessions` (`athlete_id`,`scheduled_date`);--> statement-breakpoint
CREATE TABLE `power_zones` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` text NOT NULL,
	`ftp` integer NOT NULL,
	`zones` text NOT NULL,
	`source` text NOT NULL,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `target_events` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` text NOT NULL,
	`name` text NOT NULL,
	`event_date` text NOT NULL,
	`event_type` text,
	`priority` text DEFAULT 'A',
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `training_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` text NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`phase` text,
	`methodology` text,
	`weekly_tss_target` integer,
	`weekly_hours_target` real,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `wahoo_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` text NOT NULL,
	`wahoo_user_id` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`token_expires_at` integer NOT NULL,
	`scopes` text,
	`last_sync_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wahoo_connections_athlete_id_unique` ON `wahoo_connections` (`athlete_id`);
CREATE TABLE `weight_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`athlete_id` text NOT NULL,
	`date` text NOT NULL,
	`weight_kg` real NOT NULL,
	`note` text,
	`source` text NOT NULL DEFAULT 'chat',
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (`athlete_id`) REFERENCES `athletes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_weight_logs_athlete_date` ON `weight_logs` (`athlete_id`,`date`);

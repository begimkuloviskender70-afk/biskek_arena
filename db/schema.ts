import { sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
 id: text('id').primaryKey(), steam_id: text('steam_id').notNull().unique(), nickname: text('nickname').notNull(),
 avatar: text('avatar'), faceit_id: text('faceit_id'), faceit_level: integer('faceit_level'), faceit_elo: integer('faceit_elo'), faceit_updated_at: integer('faceit_updated_at'), created_at: integer('created_at').notNull(),
});
export const sessions = sqliteTable('sessions', { token_hash: text('token_hash').primaryKey(), user_id: text('user_id').notNull().references(() => users.id, {onDelete:'cascade'}), expires_at: integer('expires_at').notNull() });
export const authStates = sqliteTable('auth_states', { state_hash: text('state_hash').primaryKey(), cookie_hash: text('cookie_hash').notNull(), return_to: text('return_to').notNull(), redirect_to: text('redirect_to').notNull(), expires_at: integer('expires_at').notNull() });
export const openidNonces = sqliteTable('openid_nonces', { nonce: text('nonce').primaryKey(), expires_at: integer('expires_at').notNull() });
export const teams = sqliteTable('teams', {
 id: text('id').primaryKey(), name: text('name').notNull(), tag: text('tag').notNull().unique(), description: text('description').notNull(), captain_id: text('captain_id').notNull().references(() => users.id), invite_code: text('invite_code').notNull().unique(), color: text('color').notNull(), created_at: integer('created_at').notNull(),
});
export const members = sqliteTable('members', {
 team_id: text('team_id').notNull().references(() => teams.id, {onDelete:'cascade'}), user_id: text('user_id').notNull().references(() => users.id), role: text('role').notNull(), joined_at: integer('joined_at').notNull(),
}, t => [primaryKey({columns:[t.team_id,t.user_id]}),uniqueIndex('one_team_per_player').on(t.user_id)]);
export const challenges = sqliteTable('challenges', {
 id: text('id').primaryKey(), team_id: text('team_id').notNull().references(() => teams.id), opponent_team_id: text('opponent_team_id').references(() => teams.id), status: text('status').notNull(), scheduled_at: integer('scheduled_at').notNull(), format: text('format').notNull(), min_level: integer('min_level').notNull(), max_level: integer('max_level').notNull(), note: text('note').notNull(), created_at: integer('created_at').notNull(), accepted_at: integer('accepted_at'),
});
export const matchPlayers = sqliteTable('match_players', {
 challenge_id: text('challenge_id').notNull().references(() => challenges.id), user_id: text('user_id').notNull().references(() => users.id), team_id: text('team_id').notNull().references(() => teams.id), steam_id: text('steam_id').notNull(),
}, t=>[primaryKey({columns:[t.challenge_id,t.user_id]})]);

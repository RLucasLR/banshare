import {
	container,
	type ChatInputCommandSuccessPayload,
	type Command,
	type ContextMenuCommandSuccessPayload,
	type MessageCommandSuccessPayload
} from '@sapphire/framework';
import { cyan } from 'colorette';
import type { APIUser, Guild, User } from 'discord.js';
import { ChannelType, EmbedBuilder, PermissionFlagsBits, type Client } from 'discord.js';
import { AuditLog, type AuditLogAction, Collection as BanCollection, Server } from '../database/models';
import { RecordNotFoundError } from '../database/models/shared';

export function logSuccessCommand(payload: ContextMenuCommandSuccessPayload | ChatInputCommandSuccessPayload | MessageCommandSuccessPayload): void {
	let successLoggerData: ReturnType<typeof getSuccessLoggerData>;

	if ('interaction' in payload) {
		successLoggerData = getSuccessLoggerData(payload.interaction.guild, payload.interaction.user, payload.command);
	} else {
		successLoggerData = getSuccessLoggerData(payload.message.guild, payload.message.author, payload.command);
	}

	container.logger.debug(`${successLoggerData.shard} - ${successLoggerData.commandName} ${successLoggerData.author} ${successLoggerData.sentAt}`);
}

export function getSuccessLoggerData(guild: Guild | null, user: User, command: Command) {
	const shard = getShardInfo(guild?.shardId ?? 0);
	const commandName = getCommandInfo(command);
	const author = getAuthorInfo(user);
	const sentAt = getGuildInfo(guild);

	return { shard, commandName, author, sentAt };
}

function getShardInfo(id: number) {
	return `[${cyan(id.toString())}]`;
}

function getCommandInfo(command: Command) {
	return cyan(command.name);
}

function getAuthorInfo(author: User | APIUser) {
	return `${author.username}[${cyan(author.id)}]`;
}

function getGuildInfo(guild: Guild | null) {
	if (guild === null) return 'Direct Messages';
	return `${guild.name}[${cyan(guild.id)}]`;
}

// logs action to audit trail, returns null if it fails
export function logAction(params: { collectionId: string; action: AuditLogAction; performedBy: string; details?: unknown }): AuditLog | null {
	try {
		const auditLog = AuditLog.create({
			collectionId: params.collectionId,
			action: params.action,
			performedBy: params.performedBy,
			details: params.details
		});

		// fire and forget, dont block
		sendAuditLogNotifications(auditLog).catch((error) => {
			console.error(`[AUDIT] Failed to send notifications for ${params.action}:`, error);
		});

		return auditLog;
	} catch (error) {
		// dont crash the app over logging lol
		console.error(`[AUDIT] Failed to log action ${params.action}:`, error);
		return null;
	}
}

// sends notifications to logging channels or dms admins if needed
async function sendAuditLogNotifications(auditLog: AuditLog): Promise<void> {
	const client = container.client;
	if (!client || !client.isReady()) {
		console.warn('[AUDIT] Client not ready, skipping notifications');
		return;
	}

	// get collection
	let collection: BanCollection;
	try {
		collection = BanCollection.getById(auditLog.collectionId);
	} catch (error) {
		if (error instanceof RecordNotFoundError) {
			console.warn(`[AUDIT] Collection not found: ${auditLog.collectionId}`);
			return;
		}
		throw error;
	}

	// bail if logging disabled
	if (!collection.loggingEnabledAtCollectionLevel) {
		console.log(`[AUDIT] Logging disabled for collection ${collection.id}, skipping notifications`);
		return;
	}

	const embed = await buildAuditLogEmbed(auditLog, collection, client);

	// get enabled servers
	const servers = Server.listByCollection(collection.id).filter((s) => s.enabled);

	let sentToServerChannel = false;

	// try each servers logging channel
	for (const server of servers) {
		if (server.loggingChannelId) {
			try {
				const guild = await client.guilds.fetch(server.guildId);
				const channel = await guild.channels.fetch(server.loggingChannelId);

				if (channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)) {
					await channel.send({ embeds: [embed] });
					sentToServerChannel = true;
					console.log(`[AUDIT] Sent notification to server ${server.guildId} channel ${server.loggingChannelId}`);
				}
			} catch (error) {
				console.error(`[AUDIT] Failed to send to server ${server.guildId} channel ${server.loggingChannelId}:`, error);
			}
		}
	}

	// fallback to main collection log
	if (!sentToServerChannel) {
		await sendToMainCollectionLog(collection, embed, client);
	}
}

// tries shareban-logs channel first, then dms admins
async function sendToMainCollectionLog(collection: BanCollection, embed: EmbedBuilder, client: Client): Promise<void> {
	try {
		const mainGuild = await client.guilds.fetch(collection.mainGuildId);

		// look for shareban-logs
		const channels = await mainGuild.channels.fetch();
		const logChannel = channels.find(
			(ch) => ch?.name === 'shareban-logs' && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
		);

		if (logChannel && (logChannel.type === ChannelType.GuildText || logChannel.type === ChannelType.GuildAnnouncement)) {
			await logChannel.send({ embeds: [embed] });
			console.log(`[AUDIT] Sent notification to main collection shareban-logs channel`);
			return;
		}

		// no channel, dm admins instead
		console.warn(`[AUDIT] shareban-logs channel not found in guild ${collection.mainGuildId}, attempting admin DMs`);
		await dmCollectionAdmins(mainGuild, collection, embed);
	} catch (error) {
		console.error(`[AUDIT] Failed to send to main collection log:`, error);
	}
}

// dm owner or admins about missing shareban-logs channel
async function dmCollectionAdmins(guild: Guild, collection: BanCollection, embed: EmbedBuilder): Promise<void> {
	const warningEmbed = new EmbedBuilder()
		.setColor(0xfee75c) // yellow
		.setTitle('Missing Audit Log Channel')
		.setDescription(
			`An audit log event occurred in collection **${collection.name}** (\`${collection.id}\`), but the **shareban-logs** channel does not exist in your server.\n\n` +
				`Please create a channel named \`shareban-logs\` to receive audit logs.`
		)
		.setFooter({ text: 'BanShare • Logs' })
		.setTimestamp();

	// try owner first
	try {
		const owner = await guild.fetchOwner();
		await owner.send({ embeds: [warningEmbed, embed] });
		console.log(`[AUDIT] DM sent to guild owner ${owner.id}`);
		return;
	} catch (error) {
		console.warn(`[AUDIT] Failed to DM guild owner:`, error);
	}

	// owner failed, try admins
	try {
		const members = await guild.members.fetch({ limit: 100 });
		const roles = await guild.roles.fetch();

		// get admin roles sorted by position
		const adminRoles = roles.filter((role) => role.permissions.has(PermissionFlagsBits.Administrator)).sort((a, b) => b.position - a.position);

		// try each admin, limit to 10 attempts
		let attempts = 0;
		const maxAttempts = 10;
		for (const adminRole of adminRoles.values()) {
			if (attempts >= maxAttempts) break;
			const adminMembers = members.filter((member) => member.roles.cache.has(adminRole.id) && !member.user.bot);

			for (const member of adminMembers.values()) {
				if (attempts >= maxAttempts) break;
				attempts++;
				try {
					await member.send({ embeds: [warningEmbed, embed] });
					console.log(`[AUDIT] DM sent to admin ${member.id} (role: ${adminRole.name})`);
					return;
				} catch {
					continue;
				}
			}
		}

		console.error(`[AUDIT] Could not DM any administrators in guild ${guild.id}`);
	} catch (error) {
		console.error(`[AUDIT] Failed to DM administrators:`, error);
	}
}

// builds the embed for audit logs
async function buildAuditLogEmbed(auditLog: AuditLog, collection: BanCollection, client: Client): Promise<EmbedBuilder> {
	const embed = new EmbedBuilder()
		.setColor(0x5865f2) // blue
		.setTitle(`Log: ${formatActionName(auditLog.action)}`)
		.setDescription(`Action performed in collection **${collection.name}**`)
		.setFooter({ text: 'BanShare • Logs' })
		.setTimestamp(new Date(auditLog.performedAt));

	// actor field
	try {
		const actor = await client.users.fetch(auditLog.performedBy);
		embed.addFields({
			name: 'Actor',
			value: `<@${actor.id}> (\`${actor.id}\`)`,
			inline: true
		});
	} catch {
		embed.addFields({
			name: 'Actor',
			value: `User ID: \`${auditLog.performedBy}\``,
			inline: true
		});
	}

	embed.addFields({
		name: 'Collection',
		value: `${collection.name} (\`${collection.id}\`)`,
		inline: true
	});

	// add extra fields based on details
	const details = auditLog.details as Record<string, unknown>;
	if (details) {
		// target user
		if (details.targetUserId || details.userId) {
			const userId = (details.targetUserId || details.userId) as string;
			try {
				const user = await client.users.fetch(userId);
				embed.addFields({
					name: 'Target',
					value: `<@${user.id}> (\`${user.id}\`)`,
					inline: true
				});
			} catch {
				embed.addFields({
					name: 'Target',
					value: `User ID: \`${userId}\``,
					inline: true
				});
			}
		}

		// guild
		if (details.guildId) {
			try {
				const guild = await client.guilds.fetch(details.guildId as string);
				embed.addFields({
					name: 'Guild',
					value: `${guild.name} (\`${guild.id}\`)`,
					inline: true
				});
			} catch {
				embed.addFields({
					name: 'Guild',
					value: `Guild ID: \`${details.guildId}\``,
					inline: true
				});
			}
		}

		// ban id
		if (details.banId) {
			embed.addFields({
				name: 'Ban ID',
				value: `\`${details.banId}\``,
				inline: true
			});
		}

		// reason
		if (details.reason) {
			const reason = String(details.reason).slice(0, 1024);
			embed.addFields({
				name: 'Reason',
				value: reason,
				inline: false
			});
		}

		// server count for bulk ops
		if (details.serverIds && Array.isArray(details.serverIds)) {
			embed.addFields({
				name: 'Affected Servers',
				value: `\`${details.serverIds.length}\` server(s)`,
				inline: true
			});
		}
	}

	return embed;
}

// formats action name for display
function formatActionName(action: AuditLogAction): string {
	const parts = action.split('.');
	const formatted = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' • ');
	return formatted;
}

import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { EmbedBuilder, InteractionContextType, type GuildMember } from 'discord.js';
import { Collection, Invite, Moderator, RecordNotFoundError, Server } from '../database/models';

const FOOTER_CATEGORY = 'BanShare • Collections';
const EMBED_COLOR = 0x5865f2; // blurple
const ERROR_COLOR = 0xed4245; // red

@ApplyOptions<Command.Options>({
	description: 'View information about your collection'
})
export class CollectionInfoCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: 'collection-info',
			description: this.description,
			contexts: [InteractionContextType.Guild]
		});
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction): Promise<void> {
		if (!interaction.guildId) {
			await interaction.reply({
				embeds: [this.errorEmbed('This command can only be used in a server.')],
				ephemeral: true
			});
			return;
		}

		console.log(`[CMD] /collection-info initiated by userId=${interaction.user.id} in guildId=${interaction.guildId}`);

		// find collection - either owns or member
		let collection: Collection | null = null;

		// check if owns
		try {
			collection = Collection.getByMainGuildId(interaction.guildId);
		} catch (error) {
			if (!(error instanceof RecordNotFoundError)) throw error;
		}

		// if not owner, check if member
		if (!collection) {
			try {
				const server = Server.getByGuildId(interaction.guildId);
				collection = Collection.getById(server.collectionId);
			} catch (error) {
				if (!(error instanceof RecordNotFoundError)) throw error;
			}
		}

		if (!collection) {
			await interaction.reply({
				embeds: [
					this.errorEmbed(
						'This server is not part of any collection. Use `/collection-create` to create one or `/collection-join` to join an existing one.'
					)
				],
				ephemeral: true
			});
			return;
		}

		// check if mod
		const isModerator = await this.isUserModerator(interaction.member as GuildMember, collection.id);
		const isOwnerGuild = collection.mainGuildId === interaction.guildId;

		if (!isModerator && !isOwnerGuild) {
			await interaction.reply({
				embeds: [this.errorEmbed('You must be a moderator of this collection to view its information.')],
				ephemeral: true
			});
			return;
		}

		await interaction.deferReply({ ephemeral: true });

		// gather info
		const moderators = Moderator.listByCollection(collection.id);
		const servers = Server.listByCollection(collection.id);
		const invites = Invite.listByCollection(collection.id).filter((inv) => inv.status === 'pending' && !inv.isExpired());

		// build embeds
		const embeds = await this.buildInfoEmbeds(collection, moderators, servers, invites);

		await interaction.editReply({ embeds });

		console.log(`[CMD] /collection-info: Displayed info for collectionId=${collection.id}`);
	}

	private async isUserModerator(member: GuildMember, collectionId: string): Promise<boolean> {
		const moderators = Moderator.listByCollection(collectionId);

		for (const mod of moderators) {
			if (mod.type === 'user' && mod.value === member.id) {
				return true;
			}
			if (mod.type === 'role' && member.roles.cache.has(mod.value)) {
				return true;
			}
		}

		return false;
	}

	private async buildInfoEmbeds(
		collection: Collection,
		moderators: Moderator[],
		servers: Server[],
		pendingInvites: Invite[]
	): Promise<EmbedBuilder[]> {
		const embeds: EmbedBuilder[] = [];
		const createdAtUnix = Math.floor(new Date(collection.createdAt).getTime() / 1000);

		// main settings embed
		const settingsEmbed = new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle(`📋 Collection: ${collection.name}`)
			.setDescription(collection.description ?? '*No description set*')
			.addFields(
				{
					name: 'Collection ID',
					value: `\`${collection.id}\``,
					inline: true
				},
				{
					name: 'Owner Guild',
					value: `\`${collection.mainGuildId}\``,
					inline: true
				},
				{
					name: 'Created',
					value: `<t:${createdAtUnix}:F>`,
					inline: true
				},
				{
					name: '📊 Settings',
					value: [
						`**Logging:** ${collection.loggingEnabledAtCollectionLevel ? '`Enabled`' : '`Disabled`'}`,
						`**DM on Ban:** ${collection.dmOnBan ? '`Enabled`' : '`Disabled`'}`,
						`**Analytics:** ${collection.analyticsEnabled ? '`Enabled`' : '`Disabled`'}`,
						`**On Server Remove:** \`${collection.onServerRemove}\``,
						`**Max Linked Servers:** \`${collection.maxLinkedServers}\``
					].join('\n'),
					inline: false
				},
				{
					name: '🖥️ Servers',
					value: `\`${servers.length}\` / \`${collection.maxLinkedServers}\` servers linked`,
					inline: true
				},
				{
					name: '📬 Pending Invites',
					value: `\`${pendingInvites.length}\` pending`,
					inline: true
				}
			)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		embeds.push(settingsEmbed);

		// mods embed
		const userMods = moderators.filter((m) => m.type === 'user');
		const roleMods = moderators.filter((m) => m.type === 'role');

		let modDescription = '';
		if (userMods.length > 0) {
			const userList = userMods
				.slice(0, 15)
				.map((m) => `• <@${m.value}>`)
				.join('\n');
			modDescription += `**Users (${userMods.length}):**\n${userList}`;
			if (userMods.length > 15) modDescription += `\n*...and ${userMods.length - 15} more*`;
		}
		if (roleMods.length > 0) {
			if (modDescription) modDescription += '\n\n';
			const roleList = roleMods
				.slice(0, 15)
				.map((m) => `• <@&${m.value}>`)
				.join('\n');
			modDescription += `**Roles (${roleMods.length}):**\n${roleList}`;
			if (roleMods.length > 15) modDescription += `\n*...and ${roleMods.length - 15} more*`;
		}
		if (!modDescription) {
			modDescription = '*No moderators assigned*';
		}

		const moderatorsEmbed = new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('👮 Moderators')
			.setDescription(modDescription)
			.setFooter({ text: FOOTER_CATEGORY });

		embeds.push(moderatorsEmbed);

		// servers embed
		let serverDescription = '';
		if (servers.length > 0) {
			const serverList: string[] = [];
			for (const server of servers.slice(0, 10)) {
				try {
					const guild = await this.container.client.guilds.fetch(server.guildId);
					serverList.push(`• **${guild.name}** (\`${server.guildId}\`)`);
				} catch {
					serverList.push(`• \`${server.guildId}\` *(not accessible)*`);
				}
			}
			serverDescription = serverList.join('\n');
			if (servers.length > 10) {
				serverDescription += `\n*...and ${servers.length - 10} more servers*`;
			}
		} else {
			serverDescription = '*No servers linked yet*';
		}

		const serversEmbed = new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('🖥️ Linked Servers')
			.setDescription(serverDescription)
			.setFooter({ text: FOOTER_CATEGORY });

		embeds.push(serversEmbed);

		// pending invites (if any)
		if (pendingInvites.length > 0) {
			const inviteList: string[] = [];
			for (const invite of pendingInvites.slice(0, 10)) {
				const expiresAtUnix = Math.floor(new Date(invite.expiresAt).getTime() / 1000);
				try {
					const guild = await this.container.client.guilds.fetch(invite.targetGuildId);
					inviteList.push(`• **${guild.name}** - Expires <t:${expiresAtUnix}:R>`);
				} catch {
					inviteList.push(`• \`${invite.targetGuildId}\` - Expires <t:${expiresAtUnix}:R>`);
				}
			}
			let inviteDescription = inviteList.join('\n');
			if (pendingInvites.length > 10) {
				inviteDescription += `\n*...and ${pendingInvites.length - 10} more pending*`;
			}

			const invitesEmbed = new EmbedBuilder()
				.setColor(EMBED_COLOR)
				.setTitle('📬 Pending Invites')
				.setDescription(inviteDescription)
				.setFooter({ text: FOOTER_CATEGORY });

			embeds.push(invitesEmbed);
		}

		return embeds;
	}

	private errorEmbed(message: string): EmbedBuilder {
		return new EmbedBuilder().setColor(ERROR_COLOR).setTitle('Error').setDescription(message).setFooter({ text: FOOTER_CATEGORY }).setTimestamp();
	}
}

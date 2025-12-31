import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	EmbedBuilder,
	GuildMember,
	PermissionFlagsBits
} from 'discord.js';
import { Collection as BanCollection } from '../database/models/collection';
import { Ban } from '../database/models/ban';
import { Server } from '../database/models/server';
import { Moderator } from '../database/models/moderator';
import { AuditLog } from '../database/models/auditLog';
import { isValidId, RecordNotFoundError } from '../database/models/shared';
import * as fs from 'fs';
import * as path from 'path';

// embed constants
const FOOTER_CATEGORY = 'BanShare • Bans';
const ERROR_COLOR = 0xed4245; // red
const SUCCESS_COLOR = 0x57f287; // green
const WARNING_COLOR = 0xfee75c; // yellow

// evidence dir
const EVIDENCE_DIR = path.join(process.cwd(), 'evidence');

@ApplyOptions<Command.Options>({
	description: 'View detailed information about a ban record'
})
export class ViewBanShareCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName('view-banshare')
				.setDescription(this.description)
				.addStringOption((option) => option.setName('id').setDescription('The ban ID to view').setRequired(true))
				.setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
		);
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		if (!interaction.guild) {
			return interaction.reply({
				embeds: [this.errorEmbed('This command can only be used in a server.', 'Server required')],
				ephemeral: true
			});
		}

		const banId = interaction.options.getString('id', true).trim();
		const executorId = interaction.user.id;

		if (!isValidId(banId)) {
			return interaction.reply({
				embeds: [this.errorEmbed('Invalid ban ID format.', 'Invalid ID')],
				ephemeral: true
			});
		}

		console.log(`[CMD] /view-banshare initiated by userId=${executorId} for banId=${banId} in guildId=${interaction.guildId}`);

		// load the ban
		let ban: Ban;
		try {
			ban = Ban.getById(banId);
		} catch (error) {
			if (error instanceof RecordNotFoundError) {
				return interaction.reply({
					embeds: [this.errorEmbed(`Ban not found with ID: \`${banId}\``, 'Ban not found')],
					ephemeral: true
				});
			}
			throw error;
		}

		// get collection
		let collection: BanCollection;
		try {
			collection = BanCollection.getById(ban.collectionId);
		} catch (error) {
			if (error instanceof RecordNotFoundError) {
				return interaction.reply({
					embeds: [this.errorEmbed('The collection for this ban no longer exists.', 'Collection not found')],
					ephemeral: true
				});
			}
			throw error;
		}

		// check if this server is part of collection
		const isMainGuild = collection.mainGuildId === interaction.guild.id;
		let isLinkedServer = false;

		if (!isMainGuild) {
			try {
				const server = Server.getByGuildId(interaction.guild.id);
				isLinkedServer = server.collectionId === collection.id && server.enabled;
			} catch {
				// not in servers
			}
		}

		if (!isMainGuild && !isLinkedServer) {
			return interaction.reply({
				embeds: [this.errorEmbed('This server is not part of the collection for this ban.', 'Server not in collection')],
				ephemeral: true
			});
		}

		// check if mod
		const member = interaction.member as GuildMember;
		const isMod = await this.isUserModerator(member, collection.id);
		const isOwner = collection.mainGuildId === interaction.guild.id && interaction.guild.ownerId === executorId;

		if (!isMod && !isOwner) {
			return interaction.reply({
				embeds: [this.errorEmbed('You must be a moderator or owner of this collection to view ban records.', 'Permission denied')],
				ephemeral: true
			});
		}

		// audit log
		AuditLog.create({
			collectionId: collection.id,
			action: 'ban.view',
			performedBy: executorId,
			details: {
				banId: ban.id,
				targetUserId: ban.userId,
				guildId: interaction.guild.id
			}
		});

		console.log(`[CMD] /view-banshare: VIEWING banId=${banId} by userId=${executorId}`);

		// show ban details
		await this.showBanDetails(interaction, collection, ban);
		return;
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

	private async showBanDetails(interaction: Command.ChatInputCommandInteraction, collection: BanCollection, ban: Ban) {
		const embed = await this.buildBanDetailsEmbed(interaction, collection, ban);
		const components = this.buildButtons(ban);

		const message = await interaction.reply({
			embeds: [embed],
			components,
			ephemeral: true,
			fetchReply: true
		});

		// button collector
		const collector = message.createMessageComponentCollector({
			componentType: ComponentType.Button,
			time: 300000 // 5 minutes
		});

		collector.on('collect', async (buttonInteraction) => {
			if (buttonInteraction.user.id !== interaction.user.id) {
				await buttonInteraction.reply({
					embeds: [this.errorEmbed('This interaction is not for you.', 'Interaction denied')],
					ephemeral: true
				});
				return;
			}

			if (buttonInteraction.customId === 'viewban_evidence') {
				collector.stop();
				await this.handleEvidenceAccess(buttonInteraction, interaction, collection, ban);
			} else if (buttonInteraction.customId === 'viewban_close') {
				console.log(`[CMD] /view-banshare: CLOSED by userId=${interaction.user.id}`);
				collector.stop();
				await buttonInteraction.update({
					embeds: [
						new EmbedBuilder()
							.setColor(SUCCESS_COLOR)
							.setTitle('View Closed')
							.setDescription('The ban view has been closed.')
							.setFooter({ text: FOOTER_CATEGORY })
							.setTimestamp()
					],
					components: []
				});
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				console.log(`[CMD] /view-banshare: TIMED OUT for userId=${interaction.user.id}`);
				try {
					await interaction.editReply({
						embeds: [this.timeoutEmbed()],
						components: []
					});
				} catch {
					// deleted maybe
				}
			}
		});
	}

	private async buildBanDetailsEmbed(interaction: Command.ChatInputCommandInteraction, collection: BanCollection, ban: Ban): Promise<EmbedBuilder> {
		// resolve banned user
		let targetUserTag = `User ID: ${ban.userId}`;
		try {
			const user = await interaction.client.users.fetch(ban.userId);
			targetUserTag = `**${user.tag}** (\`${ban.userId}\`)`;
		} catch {
			targetUserTag = `User ID: \`${ban.userId}\``;
		}

		// resolve mod
		let modTag = `Moderator ID: ${ban.moderatorId}`;
		try {
			const mod = await interaction.client.users.fetch(ban.moderatorId);
			modTag = `**${mod.tag}** (\`${ban.moderatorId}\`)`;
		} catch {
			modTag = `Moderator ID: \`${ban.moderatorId}\``;
		}

		// resolve guild
		let modGuildName = `Guild ID: ${ban.moderatorGuildId}`;
		try {
			const guild = await interaction.client.guilds.fetch(ban.moderatorGuildId);
			modGuildName = `**${guild.name}** (\`${ban.moderatorGuildId}\`)`;
		} catch {
			modGuildName = `Guild ID: \`${ban.moderatorGuildId}\``;
		}

		const embed = new EmbedBuilder()
			.setColor(ban.active ? ERROR_COLOR : WARNING_COLOR)
			.setTitle(`${ban.active ? '🔴' : '⚪'} Ban Record Details`)
			.setDescription(`Viewing ban for ${targetUserTag}`)
			.addFields(
				{
					name: 'Ban ID',
					value: `\`${ban.id}\``,
					inline: true
				},
				{
					name: 'Status',
					value: ban.active ? '`Active`' : '`Inactive`',
					inline: true
				},
				{
					name: 'Collection',
					value: `\`${collection.name}\` (\`${collection.id}\`)`,
					inline: true
				},
				{
					name: 'Banned User',
					value: targetUserTag,
					inline: false
				},
				{
					name: 'Banned By',
					value: modTag,
					inline: true
				},
				{
					name: 'From Guild',
					value: modGuildName,
					inline: true
				},
				{
					name: 'Ban Timestamp',
					value: `<t:${Math.floor(new Date(ban.timestamp).getTime() / 1000)}:F> (<t:${Math.floor(new Date(ban.timestamp).getTime() / 1000)}:R>)`,
					inline: false
				}
			);

		// add expiry if set
		if (ban.expiresAt) {
			embed.addFields({
				name: 'Expires At',
				value: `<t:${Math.floor(new Date(ban.expiresAt).getTime() / 1000)}:F> (<t:${Math.floor(new Date(ban.expiresAt).getTime() / 1000)}:R>)`,
				inline: false
			});
		}

		// add reason
		embed.addFields({
			name: 'Reason (Internal)',
			value: ban.reason ? `\`\`\`${ban.reason.slice(0, 1000)}\`\`\`` : '*No reason provided*',
			inline: false
		});

		// user facing reason
		if (ban.userFacingReason) {
			embed.addFields({
				name: 'User-Facing Reason',
				value: `\`\`\`${ban.userFacingReason.slice(0, 1000)}\`\`\``,
				inline: false
			});
		}

		// privatise setting
		embed.addFields({
			name: 'Reason Visibility',
			value: ban.privatiseReason ? '`Private` (Moderators only)' : '`Public` (Visible in logs)',
			inline: true
		});

		// mods involved
		if (ban.moderatorsInvolved.length > 0) {
			const modList = await Promise.all(
				ban.moderatorsInvolved.slice(0, 10).map(async (id) => {
					try {
						const user = await interaction.client.users.fetch(id);
						return `• ${user.tag} (\`${id}\`)`;
					} catch {
						return `• User ID: \`${id}\``;
					}
				})
			);

			embed.addFields({
				name: `Moderators Involved (${ban.moderatorsInvolved.length})`,
				value:
					modList.join('\n').slice(0, 1024) +
					(ban.moderatorsInvolved.length > 10 ? `\n...and ${ban.moderatorsInvolved.length - 10} more` : ''),
				inline: false
			});
		}

		// evidence
		if (ban.evidence.length > 0) {
			const evidenceList = ban.evidence.map((e) => `• \`${e.id.slice(0, 8)}\` - ${e.type} (\`${(e.sizeBytes / 1024).toFixed(1)}KB\`)`);
			embed.addFields({
				name: `Evidence Files (${ban.evidence.length})`,
				value: evidenceList.join('\n').slice(0, 1024),
				inline: false
			});
		} else {
			embed.addFields({
				name: 'Evidence Files',
				value: '*No evidence attached*',
				inline: false
			});
		}

		embed.setFooter({ text: FOOTER_CATEGORY }).setTimestamp();

		return embed;
	}

	private buildButtons(ban: Ban): ActionRowBuilder<ButtonBuilder>[] {
		const hasEvidence = ban.evidence.length > 0;

		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId('viewban_evidence')
					.setLabel(`View Evidence (${ban.evidence.length})`)
					.setStyle(ButtonStyle.Primary)
					.setEmoji('📎')
					.setDisabled(!hasEvidence),
				new ButtonBuilder().setCustomId('viewban_close').setLabel('Close').setStyle(ButtonStyle.Secondary).setEmoji('✖️')
			)
		];
	}

	private async handleEvidenceAccess(
		buttonInteraction: import('discord.js').ButtonInteraction,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		ban: Ban
	) {
		// audit log for evidence access
		AuditLog.create({
			collectionId: collection.id,
			action: 'evidence.access',
			performedBy: buttonInteraction.user.id,
			details: {
				banId: ban.id,
				targetUserId: ban.userId,
				evidenceCount: ban.evidence.length,
				guildId: originalInteraction.guild!.id
			}
		});

		console.log(
			`[CMD] /view-banshare: EVIDENCE ACCESSED banId=${ban.id} by userId=${buttonInteraction.user.id} evidenceCount=${ban.evidence.length}`
		);

		await buttonInteraction.deferUpdate();

		if (ban.evidence.length === 0) {
			await originalInteraction.editReply({
				embeds: [
					new EmbedBuilder()
						.setColor(WARNING_COLOR)
						.setTitle('No Evidence')
						.setDescription('There is no evidence attached to this ban.')
						.setFooter({ text: FOOTER_CATEGORY })
						.setTimestamp()
				],
				components: []
			});
			return;
		}

		// load evidence files
		const attachments: AttachmentBuilder[] = [];
		const errors: string[] = [];

		for (const evidence of ban.evidence) {
			if (evidence.storage === 'external') {
				// validate ref - no path traversal
				const safeRef = path.basename(evidence.ref);
				if (safeRef !== evidence.ref || evidence.ref.includes('..')) {
					errors.push(`• \`${evidence.id.slice(0, 8)}\`: Invalid file reference`);
					continue;
				}

				const filePath = path.join(EVIDENCE_DIR, safeRef);
				// check resolved path is within evidence dir
				const resolvedPath = path.resolve(filePath);
				if (!resolvedPath.startsWith(path.resolve(EVIDENCE_DIR) + path.sep)) {
					errors.push(`• \`${evidence.id.slice(0, 8)}\`: Invalid file path`);
					continue;
				}

				if (fs.existsSync(filePath)) {
					try {
						const fileBuffer = fs.readFileSync(filePath);
						const attachment = new AttachmentBuilder(fileBuffer, {
							name: safeRef,
							description: `Evidence ${evidence.id.slice(0, 8)} - ${evidence.type}`
						});
						attachments.push(attachment);
					} catch (error) {
						errors.push(`• \`${evidence.id.slice(0, 8)}\`: Failed to read file`);
						console.error(`[CMD] /view-banshare: Failed to read evidence file ${filePath}:`, error);
					}
				} else {
					errors.push(`• \`${evidence.id.slice(0, 8)}\`: File not found`);
					console.warn(`[CMD] /view-banshare: Evidence file not found: ${filePath}`);
				}
			} else {
				errors.push(`• \`${evidence.ref}\`: Storage type \`${evidence.storage}\` not supported`);
			}
		}

		// result embed
		const resultEmbed = new EmbedBuilder()
			.setColor(attachments.length > 0 ? SUCCESS_COLOR : ERROR_COLOR)
			.setTitle('Evidence Access')
			.setDescription(`Ban ID: \`${ban.id}\``)
			.addFields({
				name: 'Evidence Summary',
				value:
					`**Total:** \`${ban.evidence.length}\` file(s)\n` +
					`**Loaded:** \`${attachments.length}\` file(s)\n` +
					(errors.length > 0 ? `**Errors:** \`${errors.length}\` file(s)` : '**Status:** All files loaded successfully'),
				inline: false
			});

		if (errors.length > 0) {
			resultEmbed.addFields({
				name: 'Errors',
				value: errors.join('\n').slice(0, 1024),
				inline: false
			});
		}

		if (attachments.length > 0) {
			resultEmbed.addFields({
				name: 'Attached Files',
				value: attachments
					.map((a, i) => `\`${i + 1}.\` ${a.name}`)
					.join('\n')
					.slice(0, 1024),
				inline: false
			});
		}

		resultEmbed.setFooter({ text: FOOTER_CATEGORY }).setTimestamp();

		await originalInteraction.editReply({
			embeds: [resultEmbed],
			files: attachments.length > 0 ? attachments : undefined,
			components: []
		});
	}

	// helper embeds
	private errorEmbed(message: string, title = 'Error'): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(ERROR_COLOR)
			.setTitle(title.startsWith('Error:') ? title : `Error: ${title}`)
			.setDescription(message)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}

	private timeoutEmbed(): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(ERROR_COLOR)
			.setTitle('Timed Out')
			.setDescription('This view has expired. Please run the command again.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}
}

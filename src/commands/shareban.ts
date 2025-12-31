import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import {
	ActionRowBuilder,
	Attachment,
	ButtonBuilder,
	ButtonStyle,
	ComponentType,
	EmbedBuilder,
	GuildMember,
	GuildTextBasedChannel,
	Message,
	ModalBuilder,
	PermissionFlagsBits,
	TextInputBuilder,
	TextInputStyle,
	User
} from 'discord.js';
import { Collection as BanCollection } from '../database/models/collection';
import { Ban } from '../database/models/ban';
import { Server } from '../database/models/server';
import { Moderator } from '../database/models/moderator';
import { logAction } from '../lib/utils';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// embed constants
const FOOTER_CATEGORY = 'BanShare • Bans';
const EMBED_COLOR = 0x5865f2; // blurple
const ERROR_COLOR = 0xed4245; // red
const SUCCESS_COLOR = 0x57f287; // green
const WARNING_COLOR = 0xfee75c; // yellow

// regex for mentions/ids
const USER_MENTION_REGEX = /<@!?(\d{17,20})>/g;
const SNOWFLAKE_REGEX = /\b(\d{17,20})\b/g;

// evidence config
const EVIDENCE_DIR = path.join(process.cwd(), 'evidence');
const MAX_EVIDENCE_FILES = 5;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

// make sure evidence dir exists
if (!fs.existsSync(EVIDENCE_DIR)) {
	fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

// file type validation via magic bytes
const ALLOWED_MAGIC_BYTES: { [key: string]: number[][] } = {
	// images
	png: [[0x89, 0x50, 0x4e, 0x47]],
	jpg: [
		[0xff, 0xd8, 0xff, 0xe0],
		[0xff, 0xd8, 0xff, 0xe1],
		[0xff, 0xd8, 0xff, 0xe2],
		[0xff, 0xd8, 0xff, 0xdb]
	],
	gif: [
		[0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
		[0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
	],
	webp: [[0x52, 0x49, 0x46, 0x46]], // riff header, also check for WEBP
	bmp: [[0x42, 0x4d]],
	// documents
	pdf: [[0x25, 0x50, 0x44, 0x46]],
	// videos
	mp4: [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]], // ftyp header
	webm: [[0x1a, 0x45, 0xdf, 0xa3]],
	// text (utf-8 bom or printable ascii)
	txt: [[0xef, 0xbb, 0xbf]] // utf-8 bom
};

// blocked executable sigs
const BLOCKED_MAGIC_BYTES: number[][] = [
	[0x4d, 0x5a], // windows exe/dll
	[0x7f, 0x45, 0x4c, 0x46], // linux elf
	[0xca, 0xfe, 0xba, 0xbe], // macho
	[0xcf, 0xfa, 0xed, 0xfe], // macho 64bit
	[0x50, 0x4b, 0x03, 0x04] // zip (could be jar/apk/etc)
];

interface EvidenceFile {
	id: string;
	originalName: string;
	storedPath: string;
	mimeType: string;
	size: number;
}

interface BanConfiguration {
	targetUser: User;
	collectionId: string;
	selectedServerGuildIds: Set<string>;
	reason: string;
	userFacingReason: string;
	privatiseReason: boolean;
	moderatorsInvolved: string[];
	evidence: EvidenceFile[];
	dmUser: boolean;
}

// server info for tracking servers in collection (inc main)
interface ServerInfo {
	guildId: string;
	isMainServer: boolean;
}

// build server list including main
function buildServerInfoList(collection: BanCollection): ServerInfo[] {
	const linkedServers = Server.listByCollection(collection.id).filter((s) => s.enabled);
	const mainServerInList = linkedServers.some((s) => s.guildId === collection.mainGuildId);

	const serverInfos: ServerInfo[] = [];

	// add main first if not already in
	if (!mainServerInList) {
		serverInfos.push({ guildId: collection.mainGuildId, isMainServer: true });
	}

	// add linked
	for (const server of linkedServers) {
		serverInfos.push({
			guildId: server.guildId,
			isMainServer: server.guildId === collection.mainGuildId
		});
	}

	return serverInfos;
}

function checkMagicBytes(buffer: Buffer, signatures: number[][]): boolean {
	return signatures.some((sig) => {
		if (buffer.length < sig.length) return false;
		return sig.every((byte, index) => buffer[index] === byte);
	});
}

function isBlockedFile(buffer: Buffer): boolean {
	return BLOCKED_MAGIC_BYTES.some((sig) => checkMagicBytes(buffer, [sig]));
}

function isAllowedFile(buffer: Buffer): boolean {
	// check blocked first
	if (isBlockedFile(buffer)) return false;

	// check allowed types
	for (const [, signatures] of Object.entries(ALLOWED_MAGIC_BYTES)) {
		if (checkMagicBytes(buffer, signatures)) return true;
	}

	// also allow plaintext
	const isPlainText = Array.from(buffer.slice(0, 100)).every(
		(byte) => (byte >= 0x20 && byte <= 0x7e) || byte === 0x0a || byte === 0x0d || byte === 0x09
	);
	if (isPlainText) return true;

	return false;
}

async function downloadFile(url: string, maxSize: number): Promise<{ buffer: Buffer; contentType: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30_000);
	try {
		const response = await fetch(url, {
			headers: {
				'User-Agent': 'DiscordBot (BanShare, 1.0)'
			},
			signal: controller.signal
		});

		if (!response.ok) {
			throw new Error(`Failed to download: HTTP ${response.status}`);
		}

		const contentLength = response.headers.get('content-length');
		if (contentLength && parseInt(contentLength, 10) > maxSize) {
			throw new Error(`File too large`);
		}

		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		if (buffer.length > maxSize) {
			throw new Error(`File too large`);
		}

		return {
			buffer,
			contentType: response.headers.get('content-type') || 'unknown'
		};
	} finally {
		clearTimeout(timeout);
	}
}

function getFileExtension(contentType: string, originalName: string): string {
	const mimeToExt: { [key: string]: string } = {
		'image/png': 'png',
		'image/jpeg': 'jpg',
		'image/gif': 'gif',
		'image/webp': 'webp',
		'image/bmp': 'bmp',
		'application/pdf': 'pdf',
		'video/mp4': 'mp4',
		'video/webm': 'webm',
		'text/plain': 'txt'
	};

	// try content type first
	if (mimeToExt[contentType]) return mimeToExt[contentType];

	// fall back to original ext
	const ext = path.extname(originalName).toLowerCase().slice(1);
	if (ext) return ext;

	return 'bin';
}

@ApplyOptions<Command.Options>({
	description: 'Create and share a ban across collection servers'
})
export class ShareBanCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName('shareban')
				.setDescription(this.description)
				.addUserOption((option) => option.setName('target').setDescription('The user to ban').setRequired(true))
				.setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
		);
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		if (!interaction.guild) {
			return interaction.reply({
				embeds: [this.errorEmbed('This command can only be used in a server.')],
				ephemeral: true
			});
		}

		const targetUser = interaction.options.getUser('target', true);
		const executorId = interaction.user.id;

		console.log(`[CMD] /shareban initiated by userId=${executorId} targeting userId=${targetUser.id} in guildId=${interaction.guildId}`);

		// get collection for this server
		let collection: BanCollection | null = null;

		// check if main guild
		try {
			collection = BanCollection.getByMainGuildId(interaction.guild.id);
		} catch {
			// not a main guild, check servers table
		}

		// if not main, check linked
		if (!collection) {
			let server: Server | null = null;
			try {
				server = Server.getByGuildId(interaction.guild.id);
			} catch {
				// not found
			}

			if (!server || !server.enabled) {
				return interaction.reply({
					embeds: [this.errorEmbed('This server is not part of any ban sharing collection, or is not enabled.')],
					ephemeral: true
				});
			}
			try {
				collection = BanCollection.getById(server.collectionId);
			} catch {
				// not found
			}
		}

		if (!collection) {
			return interaction.reply({
				embeds: [this.errorEmbed('Could not find the collection for this server.')],
				ephemeral: true
			});
		}

		// check if mod
		const member = interaction.member as GuildMember;
		const isMod = await this.isUserModerator(member, collection.id);
		const isOwner = collection.mainGuildId === interaction.guild.id && interaction.guild.ownerId === executorId;

		if (!isMod && !isOwner) {
			return interaction.reply({
				embeds: [this.errorEmbed('You must be a moderator or owner of this collection to share bans.')],
				ephemeral: true
			});
		}

		// get all enabled servers
		const allServers = buildServerInfoList(collection);

		if (allServers.length === 0) {
			return interaction.reply({
				embeds: [this.errorEmbed('There are no enabled servers in this collection to share the ban with.')],
				ephemeral: true
			});
		}

		// check if already banned
		const existingBans = Ban.listByCollection(collection.id, true);
		const existingBan = existingBans.find((b) => b.userId === targetUser.id);
		if (existingBan) {
			return interaction.reply({
				embeds: [this.errorEmbed(`**${targetUser.tag}** is already banned in this collection.\n\nBan ID: \`${existingBan.id}\``)],
				ephemeral: true
			});
		}

		// init config - all servers selected
		const allServerGuildIds = allServers.map((s) => s.guildId);
		const config: BanConfiguration = {
			targetUser,
			collectionId: collection.id,
			selectedServerGuildIds: new Set(allServerGuildIds),
			reason: '',
			userFacingReason: '',
			privatiseReason: true,
			moderatorsInvolved: [],
			evidence: [],
			dmUser: true
		};

		await this.showConfigurationMenu(interaction, collection, allServers, config);
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

	private async showConfigurationMenu(
		interaction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	) {
		const embed = await this.buildConfigurationEmbed(interaction, collection, allServers, config);
		const components = this.buildConfigurationButtons(collection, allServers, config);

		const message = await interaction.reply({
			embeds: [embed],
			components,
			ephemeral: true,
			fetchReply: true
		});

		const collector = message.createMessageComponentCollector({
			componentType: ComponentType.Button,
			time: 600000 // 10 minutes
		});

		collector.on('collect', async (buttonInteraction) => {
			if (buttonInteraction.user.id !== interaction.user.id) {
				await buttonInteraction.reply({
					embeds: [this.errorEmbed('This interaction is not for you.')],
					ephemeral: true
				});
				return;
			}

			const customId = buttonInteraction.customId;

			if (customId === 'shareban_reason') {
				await this.handleReasonModal(buttonInteraction, interaction, collection, allServers, config);
			} else if (customId === 'shareban_user_reason') {
				await this.handleUserReasonModal(buttonInteraction, interaction, collection, allServers, config);
			} else if (customId === 'shareban_privatise') {
				await this.handleToggleSetting(
					buttonInteraction,
					interaction,
					collection,
					allServers,
					config,
					'privatiseReason',
					'Privatise Reason',
					'When enabled, the ban reason will be hidden from public logs and only visible to moderators.'
				);
			} else if (customId === 'shareban_dm') {
				await this.handleToggleSetting(
					buttonInteraction,
					interaction,
					collection,
					allServers,
					config,
					'dmUser',
					'DM User',
					'When enabled, the banned user will receive a DM notification with the ban reason and affected servers.'
				);
			} else if (customId === 'shareban_moderators') {
				await this.handleModeratorsSelection(buttonInteraction, interaction, collection, allServers, config);
			} else if (customId === 'shareban_evidence') {
				await this.handleEvidenceUpload(buttonInteraction, interaction, collection, allServers, config);
			} else if (customId === 'shareban_servers') {
				await this.handleSelectServers(buttonInteraction, interaction, collection, allServers, config);
			} else if (customId === 'shareban_confirm') {
				collector.stop();
				await this.handleConfirmBan(buttonInteraction, interaction, collection, allServers, config);
			} else if (customId === 'shareban_cancel') {
				console.log(`[CMD] /shareban: CANCELLED by userId=${interaction.user.id}`);
				collector.stop();
				await buttonInteraction.update({
					embeds: [this.cancelledEmbed()],
					components: []
				});
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				console.log(`[CMD] /shareban: TIMED OUT for userId=${interaction.user.id}`);
				// clean up evidence files
				for (const file of config.evidence) {
					try {
						if (fs.existsSync(file.storedPath)) {
							fs.unlinkSync(file.storedPath);
						}
					} catch {
						// whatever
					}
				}

				try {
					await interaction.editReply({
						embeds: [this.timeoutEmbed()],
						components: []
					});
				} catch {
					// msg prob deleted
				}
			}
		});
	}

	private async buildConfigurationEmbed(
		interaction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	): Promise<EmbedBuilder> {
		// resolve server names
		const selectedServers: string[] = [];
		for (const guildId of config.selectedServerGuildIds) {
			try {
				const guild = await interaction.client.guilds.fetch(guildId);
				const isMain = guildId === collection.mainGuildId;
				selectedServers.push(isMain ? `• **${guild.name}** (Main)` : `• ${guild.name}`);
			} catch {
				selectedServers.push(`• Unknown (\`${guildId}\`)`);
			}
		}

		const embed = new EmbedBuilder()
			.setTitle('ShareBan Configuration')
			.setColor(EMBED_COLOR)
			.setDescription(`Configure the ban for **${config.targetUser.tag}**\nUser ID: \`${config.targetUser.id}\``)
			.addFields(
				{
					name: 'Collection',
					value: `\`${collection.name}\``,
					inline: true
				},
				{
					name: 'Collection ID',
					value: `\`${collection.id}\``,
					inline: true
				},
				{
					name: 'Servers Selected',
					value: selectedServers.length > 0 ? selectedServers.join('\n').slice(0, 1024) : '*None selected*',
					inline: false
				},
				{
					name: 'Reason (Internal)',
					value: config.reason ? `\`\`\`${config.reason.slice(0, 900)}\`\`\`` : '*Not set*',
					inline: false
				},
				{
					name: 'User-Facing Reason',
					value: config.userFacingReason ? `\`\`\`${config.userFacingReason.slice(0, 900)}\`\`\`` : '*Will use internal reason*',
					inline: false
				},
				{
					name: 'Privatise Reason',
					value: config.privatiseReason ? '`Enabled`' : '`Disabled`',
					inline: true
				},
				{
					name: 'DM User',
					value: config.dmUser ? '`Enabled`' : '`Disabled`',
					inline: true
				},
				{
					name: 'Moderators Involved',
					value: config.moderatorsInvolved.length > 0 ? config.moderatorsInvolved.map((id) => `<@${id}>`).join(', ') : '*None added*',
					inline: false
				},
				{
					name: 'Evidence',
					value:
						config.evidence.length > 0
							? config.evidence.map((e) => `• \`${e.originalName}\` (\`${e.id.slice(0, 8)}\`)`).join('\n')
							: `*No evidence uploaded (\`0/${MAX_EVIDENCE_FILES}\`)*`,
					inline: false
				}
			)
			.setFooter({
				text: `${FOOTER_CATEGORY} • ${config.selectedServerGuildIds.size}/${allServers.length} servers selected`
			})
			.setTimestamp();

		return embed;
	}

	private buildConfigurationButtons(
		_collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	): ActionRowBuilder<ButtonBuilder>[] {
		const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId('shareban_reason')
				.setLabel('Set Reason')
				.setStyle(config.reason ? ButtonStyle.Success : ButtonStyle.Secondary)
				.setEmoji('📝'),
			new ButtonBuilder()
				.setCustomId('shareban_user_reason')
				.setLabel('User Reason')
				.setStyle(config.userFacingReason ? ButtonStyle.Success : ButtonStyle.Secondary)
				.setEmoji('💬'),
			new ButtonBuilder()
				.setCustomId('shareban_privatise')
				.setLabel(config.privatiseReason ? 'Privatised' : 'Public')
				.setStyle(config.privatiseReason ? ButtonStyle.Success : ButtonStyle.Danger)
				.setEmoji(config.privatiseReason ? '🔒' : '🔓'),
			new ButtonBuilder()
				.setCustomId('shareban_dm')
				.setLabel(config.dmUser ? 'DM: On' : 'DM: Off')
				.setStyle(config.dmUser ? ButtonStyle.Success : ButtonStyle.Secondary)
				.setEmoji('✉️')
		);

		const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId('shareban_servers')
				.setLabel(`Servers (${config.selectedServerGuildIds.size}/${allServers.length})`)
				.setStyle(ButtonStyle.Primary)
				.setEmoji('🌐'),
			new ButtonBuilder()
				.setCustomId('shareban_moderators')
				.setLabel(`Moderators (${config.moderatorsInvolved.length})`)
				.setStyle(ButtonStyle.Primary)
				.setEmoji('👥'),
			new ButtonBuilder()
				.setCustomId('shareban_evidence')
				.setLabel(`Evidence (${config.evidence.length}/${MAX_EVIDENCE_FILES})`)
				.setStyle(ButtonStyle.Primary)
				.setEmoji('📎')
				.setDisabled(config.evidence.length >= MAX_EVIDENCE_FILES)
		);

		// check if ready to confirm
		const canConfirm = config.reason.length > 0 && config.selectedServerGuildIds.size > 0;

		const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId('shareban_confirm')
				.setLabel('Confirm Ban')
				.setStyle(ButtonStyle.Danger)
				.setEmoji('⚠️')
				.setDisabled(!canConfirm),
			new ButtonBuilder().setCustomId('shareban_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('✖️')
		);

		return [row1, row2, row3];
	}

	private async handleReasonModal(
		buttonInteraction: import('discord.js').ButtonInteraction,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	) {
		const modal = new ModalBuilder()
			.setCustomId('shareban_reason_modal')
			.setTitle('Set Ban Reason')
			.addComponents(
				new ActionRowBuilder<TextInputBuilder>().addComponents(
					new TextInputBuilder()
						.setCustomId('reason_input')
						.setLabel('Ban Reason (Internal)')
						.setStyle(TextInputStyle.Paragraph)
						.setPlaceholder('Enter the reason for this ban...')
						.setValue(config.reason)
						.setRequired(true)
						.setMaxLength(1000)
				)
			);

		await buttonInteraction.showModal(modal);

		try {
			const modalSubmit = await buttonInteraction.awaitModalSubmit({
				time: 300000,
				filter: (i) => i.customId === 'shareban_reason_modal' && i.user.id === buttonInteraction.user.id
			});

			config.reason = modalSubmit.fields.getTextInputValue('reason_input');

			const embed = await this.buildConfigurationEmbed(originalInteraction, collection, allServers, config);
			const components = this.buildConfigurationButtons(collection, allServers, config);

			await modalSubmit.deferUpdate();
			await originalInteraction.editReply({
				embeds: [embed],
				components
			});
		} catch {
			// modal timeout
		}
	}

	private async handleUserReasonModal(
		buttonInteraction: import('discord.js').ButtonInteraction,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	) {
		const modal = new ModalBuilder()
			.setCustomId('shareban_user_reason_modal')
			.setTitle('Set User-Facing Reason')
			.addComponents(
				new ActionRowBuilder<TextInputBuilder>().addComponents(
					new TextInputBuilder()
						.setCustomId('user_reason_input')
						.setLabel('User-Facing Reason')
						.setStyle(TextInputStyle.Paragraph)
						.setPlaceholder('Enter the reason to show the user (leave empty to use internal reason)...')
						.setValue(config.userFacingReason)
						.setRequired(false)
						.setMaxLength(1000)
				)
			);

		await buttonInteraction.showModal(modal);

		try {
			const modalSubmit = await buttonInteraction.awaitModalSubmit({
				time: 300000,
				filter: (i) => i.customId === 'shareban_user_reason_modal' && i.user.id === buttonInteraction.user.id
			});

			config.userFacingReason = modalSubmit.fields.getTextInputValue('user_reason_input');

			const embed = await this.buildConfigurationEmbed(originalInteraction, collection, allServers, config);
			const components = this.buildConfigurationButtons(collection, allServers, config);

			await modalSubmit.deferUpdate();
			await originalInteraction.editReply({
				embeds: [embed],
				components
			});
		} catch {
			// modal timeout
		}
	}

	private async handleModeratorsSelection(
		buttonInteraction: import('discord.js').ButtonInteraction,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	) {
		const channel = buttonInteraction.channel;
		if (!channel || !channel.isTextBased() || channel.isDMBased()) {
			await buttonInteraction.reply({
				embeds: [this.errorEmbed('Cannot manage moderators in this channel type.')],
				ephemeral: true
			});
			return;
		}

		await buttonInteraction.deferUpdate();

		// show mod list
		const embed = this.buildModeratorsListEmbed(config);
		const components = this.buildModeratorsButtons();

		const modsMessage = await channel.send({
			embeds: [embed],
			components
		});

		const collector = modsMessage.createMessageComponentCollector({
			filter: (i) => i.user.id === buttonInteraction.user.id && i.customId.startsWith('shareban:mods:'),
			time: 300_000 // 5 minutes
		});

		collector.on('collect', async (i) => {
			if (i.customId === 'shareban:mods:add') {
				collector.stop('action');
				await i.deferUpdate();
				await this.handleAddModeratorsFlow(i, modsMessage, originalInteraction, collection, allServers, config);
			} else if (i.customId === 'shareban:mods:remove') {
				if (config.moderatorsInvolved.length === 0) {
					await i.reply({
						embeds: [this.errorEmbed('There are no moderators to remove.')],
						ephemeral: true
					});
					return;
				}
				collector.stop('action');
				await i.deferUpdate();
				await this.handleRemoveModeratorsFlow(i, modsMessage, originalInteraction, collection, allServers, config);
			} else if (i.customId === 'shareban:mods:done') {
				collector.stop('done');
				await i.deferUpdate();
				// show done then delete
				await modsMessage.edit({
					embeds: [
						new EmbedBuilder()
							.setColor(SUCCESS_COLOR)
							.setTitle('Moderators Updated')
							.setDescription(`\`${config.moderatorsInvolved.length}\` moderator(s) selected.`)
							.setFooter({ text: FOOTER_CATEGORY })
							.setTimestamp()
					],
					components: []
				});
				setTimeout(() => modsMessage.delete().catch(() => {}), 3000);

				// update main menu
				const mainEmbed = await this.buildConfigurationEmbed(originalInteraction, collection, allServers, config);
				const mainComponents = this.buildConfigurationButtons(collection, allServers, config);
				await originalInteraction.editReply({ embeds: [mainEmbed], components: mainComponents });
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				await modsMessage
					.edit({
						embeds: [this.timeoutEmbed()],
						components: []
					})
					.catch(() => {});
				setTimeout(() => modsMessage.delete().catch(() => {}), 5000);
			}
		});
	}

	private buildModeratorsListEmbed(config: BanConfiguration): EmbedBuilder {
		const embed = new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('Moderators Involved')
			.setDescription('Manage moderators involved in this ban.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		if (config.moderatorsInvolved.length === 0) {
			embed.addFields({
				name: 'Moderators',
				value: '*No moderators added yet.*',
				inline: false
			});
		} else {
			const modList = config.moderatorsInvolved.map((id) => `• <@${id}> (\`${id}\`)`).join('\n');
			embed.addFields({
				name: `Moderators (${config.moderatorsInvolved.length})`,
				value: modList.length > 1024 ? modList.substring(0, 1020) + '...' : modList,
				inline: false
			});
		}

		return embed;
	}

	private buildModeratorsButtons(): ActionRowBuilder<ButtonBuilder>[] {
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId('shareban:mods:add').setLabel('Add Moderators').setStyle(ButtonStyle.Success).setEmoji('➕'),
				new ButtonBuilder().setCustomId('shareban:mods:remove').setLabel('Remove Moderators').setStyle(ButtonStyle.Danger).setEmoji('➖'),
				new ButtonBuilder().setCustomId('shareban:mods:done').setLabel('Done').setStyle(ButtonStyle.Secondary).setEmoji('✅')
			)
		];
	}

	private async handleAddModeratorsFlow(
		i: import('discord.js').MessageComponentInteraction,
		modsMessage: Message,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	): Promise<void> {
		await modsMessage.edit({
			embeds: [
				new EmbedBuilder()
					.setColor(WARNING_COLOR)
					.setTitle('Adding Moderators')
					.setDescription('Check the channel for instructions.')
					.setFooter({ text: FOOTER_CATEGORY })
					.setTimestamp()
			],
			components: []
		});

		const instructionEmbed = new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('Add Moderators')
			.setDescription(
				"**Press Start when you're ready to add moderators.**\n\n" +
					'After pressing Start, send messages containing:\n' +
					'• **User mentions**: @user1 @user2\n' +
					'• **User IDs**: `123456789012345678`\n\n' +
					'Send **stop**, **done**, or any non-ID/mention text to finish.'
			)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		const startRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId('shareban:mods:add:start').setLabel('Start').setStyle(ButtonStyle.Success).setEmoji('▶️'),
			new ButtonBuilder().setCustomId('shareban:mods:add:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
		);

		const channel = i.channel as GuildTextBasedChannel;
		const instructionMessage = await channel.send({
			embeds: [instructionEmbed],
			components: [startRow]
		});

		const buttonCollector = instructionMessage.createMessageComponentCollector({
			filter: (btn) => btn.user.id === i.user.id && btn.customId.startsWith('shareban:mods:add:'),
			time: 60_000,
			max: 1
		});

		buttonCollector.on('collect', async (btn) => {
			if (btn.customId === 'shareban:mods:add:cancel') {
				await btn.deferUpdate();
				await instructionMessage.delete().catch(() => {});
				await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, allServers, config);
				return;
			}

			await btn.deferUpdate();
			await this.collectModeratorsToAdd(instructionMessage, modsMessage, originalInteraction, collection, allServers, config);
		});

		buttonCollector.on('end', async (collected, reason) => {
			if (reason === 'time' && collected.size === 0) {
				await instructionMessage.delete().catch(() => {});
				await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, allServers, config);
			}
		});
	}

	private async collectModeratorsToAdd(
		instructionMessage: Message,
		modsMessage: Message,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	): Promise<void> {
		const collectingEmbed = new EmbedBuilder()
			.setColor(SUCCESS_COLOR)
			.setTitle('📝 Now Accepting Moderators')
			.setDescription('**Start pinging/typing moderators now!**\n\n' + 'Type **stop**, **done**, or any other text to finish.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		await instructionMessage.edit({ embeds: [collectingEmbed], components: [] });

		const addedMods: string[] = [];
		const existingSet = new Set(config.moderatorsInvolved);

		const channel = instructionMessage.channel as GuildTextBasedChannel;
		const messageCollector = channel.createMessageCollector({
			filter: (m: Message) => m.author.id === originalInteraction.user.id,
			time: 120_000
		});

		messageCollector.on('collect', async (message: Message) => {
			const content = message.content;
			const lowerContent = content.toLowerCase().trim();

			if (['stop', 'done', 'cancel', 'finish', 'end'].includes(lowerContent)) {
				messageCollector.stop('completed');
				return;
			}

			const userMatches = [...content.matchAll(USER_MENTION_REGEX)];
			for (const match of userMatches) {
				const userId = match[1];
				if (!existingSet.has(userId)) {
					addedMods.push(userId);
					existingSet.add(userId);
				}
			}

			const mentionedIds = new Set(userMatches.map((m) => m[1]));
			const rawIdMatches = [...content.matchAll(SNOWFLAKE_REGEX)];
			for (const match of rawIdMatches) {
				const id = match[1];
				if (mentionedIds.has(id)) continue;
				if (!existingSet.has(id)) {
					addedMods.push(id);
					existingSet.add(id);
				}
			}

			if (userMatches.length === 0 && rawIdMatches.length === 0) {
				messageCollector.stop('completed');
				return;
			}

			await message.delete().catch(() => {});
		});

		messageCollector.on('end', async () => {
			for (const modId of addedMods) {
				if (!config.moderatorsInvolved.includes(modId)) {
					config.moderatorsInvolved.push(modId);
				}
			}

			console.log(`[ShareBan] Added ${addedMods.length} moderators, total: ${config.moderatorsInvolved.length}`);

			const resultEmbed = new EmbedBuilder()
				.setColor(addedMods.length > 0 ? SUCCESS_COLOR : WARNING_COLOR)
				.setTitle('Moderators Added')
				.setDescription(
					addedMods.length > 0
						? `**Added ${addedMods.length} moderator(s):**\n${addedMods.map((id) => `<@${id}>`).join(', ')}`
						: 'No new moderators were added.'
				)
				.setFooter({ text: FOOTER_CATEGORY })
				.setTimestamp();

			await instructionMessage.edit({ embeds: [resultEmbed], components: [] });

			setTimeout(async () => {
				await instructionMessage.delete().catch(() => {});
			}, 5000);

			await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, allServers, config);
		});
	}

	private async handleRemoveModeratorsFlow(
		i: import('discord.js').MessageComponentInteraction,
		modsMessage: Message,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	): Promise<void> {
		await modsMessage.edit({
			embeds: [
				new EmbedBuilder()
					.setColor(WARNING_COLOR)
					.setTitle('Removing Moderators')
					.setDescription('Check the channel for instructions.')
					.setFooter({ text: FOOTER_CATEGORY })
					.setTimestamp()
			],
			components: []
		});

		const modList = config.moderatorsInvolved.map((id) => `• <@${id}> (\`${id}\`)`).join('\n');

		const instructionEmbed = new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('Remove Moderators')
			.setDescription(
				"**Press Start when you're ready to remove moderators.**\n\n" +
					'After pressing Start, ping or type the IDs of moderators to remove.\n' +
					'Send **stop**, **done**, or any non-ID/mention text to finish.'
			)
			.addFields({
				name: 'Current Moderators',
				value: modList.length > 1024 ? modList.substring(0, 1020) + '...' : modList
			})
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		const startRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId('shareban:mods:remove:start').setLabel('Start').setStyle(ButtonStyle.Danger).setEmoji('▶️'),
			new ButtonBuilder().setCustomId('shareban:mods:remove:clear').setLabel('Clear All').setStyle(ButtonStyle.Danger),
			new ButtonBuilder().setCustomId('shareban:mods:remove:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
		);

		const channel = i.channel as GuildTextBasedChannel;
		const instructionMessage = await channel.send({
			embeds: [instructionEmbed],
			components: [startRow]
		});

		const buttonCollector = instructionMessage.createMessageComponentCollector({
			filter: (btn) => btn.user.id === i.user.id && btn.customId.startsWith('shareban:mods:remove:'),
			time: 60_000,
			max: 1
		});

		buttonCollector.on('collect', async (btn) => {
			if (btn.customId === 'shareban:mods:remove:cancel') {
				await btn.deferUpdate();
				await instructionMessage.delete().catch(() => {});
				await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, allServers, config);
				return;
			}

			if (btn.customId === 'shareban:mods:remove:clear') {
				config.moderatorsInvolved = [];
				console.log(`[ShareBan] Cleared all moderators`);
				await btn.deferUpdate();
				await instructionMessage.delete().catch(() => {});
				await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, allServers, config);
				return;
			}

			await btn.deferUpdate();
			await this.collectModeratorsToRemove(instructionMessage, modsMessage, originalInteraction, collection, allServers, config);
		});

		buttonCollector.on('end', async (collected, reason) => {
			if (reason === 'time' && collected.size === 0) {
				await instructionMessage.delete().catch(() => {});
				await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, allServers, config);
			}
		});
	}

	private async collectModeratorsToRemove(
		instructionMessage: Message,
		modsMessage: Message,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	): Promise<void> {
		const collectingEmbed = new EmbedBuilder()
			.setColor(ERROR_COLOR)
			.setTitle('📝 Ping/Type Moderators to Remove')
			.setDescription('Type **stop**, **done**, or any other text to finish.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		await instructionMessage.edit({ embeds: [collectingEmbed], components: [] });

		const removedMods: string[] = [];

		const channel = instructionMessage.channel as GuildTextBasedChannel;
		const messageCollector = channel.createMessageCollector({
			filter: (m: Message) => m.author.id === originalInteraction.user.id,
			time: 120_000
		});

		messageCollector.on('collect', async (message: Message) => {
			const content = message.content;
			const lowerContent = content.toLowerCase().trim();

			if (['stop', 'done', 'cancel', 'finish', 'end'].includes(lowerContent)) {
				messageCollector.stop('completed');
				return;
			}

			const userMatches = [...content.matchAll(USER_MENTION_REGEX)];
			for (const match of userMatches) {
				const userId = match[1];
				if (config.moderatorsInvolved.includes(userId) && !removedMods.includes(userId)) {
					removedMods.push(userId);
				}
			}

			const mentionedIds = new Set(userMatches.map((m) => m[1]));
			const rawIdMatches = [...content.matchAll(SNOWFLAKE_REGEX)];
			for (const match of rawIdMatches) {
				const id = match[1];
				if (mentionedIds.has(id)) continue;
				if (config.moderatorsInvolved.includes(id) && !removedMods.includes(id)) {
					removedMods.push(id);
				}
			}

			if (userMatches.length === 0 && rawIdMatches.length === 0) {
				messageCollector.stop('completed');
				return;
			}

			await message.delete().catch(() => {});
		});

		messageCollector.on('end', async () => {
			config.moderatorsInvolved = config.moderatorsInvolved.filter((id) => !removedMods.includes(id));

			console.log(`[ShareBan] Removed ${removedMods.length} moderators, total: ${config.moderatorsInvolved.length}`);

			const resultEmbed = new EmbedBuilder()
				.setColor(removedMods.length > 0 ? SUCCESS_COLOR : WARNING_COLOR)
				.setTitle('Moderators Removed')
				.setDescription(
					removedMods.length > 0
						? `**Removed ${removedMods.length} moderator(s):**\n${removedMods.map((id) => `<@${id}>`).join(', ')}`
						: 'No moderators were removed.'
				)
				.setFooter({ text: FOOTER_CATEGORY })
				.setTimestamp();

			await instructionMessage.edit({ embeds: [resultEmbed], components: [] });

			setTimeout(async () => {
				await instructionMessage.delete().catch(() => {});
			}, 5000);

			await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, allServers, config);
		});
	}

	private async refreshModeratorsMenu(
		modsMessage: Message,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	): Promise<void> {
		const embed = this.buildModeratorsListEmbed(config);
		const components = this.buildModeratorsButtons();
		await modsMessage.edit({ embeds: [embed], components });

		const mainEmbed = await this.buildConfigurationEmbed(originalInteraction, collection, allServers, config);
		const mainComponents = this.buildConfigurationButtons(collection, allServers, config);
		await originalInteraction.editReply({ embeds: [mainEmbed], components: mainComponents });
	}

	private async handleEvidenceUpload(
		buttonInteraction: import('discord.js').ButtonInteraction,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	) {
		const channel = buttonInteraction.channel;
		if (!channel || !channel.isTextBased() || channel.isDMBased()) {
			await buttonInteraction.reply({
				embeds: [this.errorEmbed('Cannot collect messages in this channel type.')],
				ephemeral: true
			});
			return;
		}

		await buttonInteraction.deferUpdate();

		// instruction msg
		const instructionMessage = await channel.send({
			embeds: [
				new EmbedBuilder()
					.setColor(EMBED_COLOR)
					.setTitle('Upload Evidence')
					.setDescription(
						'Please send a message with file attachments (images, PDFs, videos, or text files).\n\nSend your files now, or type `cancel` to go back.'
					)
					.addFields({
						name: 'Limits',
						value: `• Max \`${MAX_EVIDENCE_FILES}\` files total (\`${config.evidence.length}\` already uploaded)\n• Max \`25MB\` per file\n• Allowed: Images, PDFs, Videos, Text files\n• Blocked: Executables, Archives`,
						inline: false
					})
					.setFooter({ text: FOOTER_CATEGORY })
					.setTimestamp()
			]
		});

		try {
			const collected = await channel.awaitMessages({
				filter: (m: import('discord.js').Message) => m.author.id === buttonInteraction.user.id,
				max: 1,
				time: 120000,
				errors: ['time']
			});

			const response = collected.first();
			if (!response) return;

			if (response.content.toLowerCase() === 'cancel') {
				// delete msgs
				await response.delete().catch(() => {});
				await instructionMessage.delete().catch(() => {});
				return;
			}

			if (response.attachments.size === 0) {
				// delete their msg
				await response.delete().catch(() => {});
				// show error then delete
				await instructionMessage.edit({
					embeds: [this.errorEmbed('No attachments found in your message. Please try again.')]
				});
				setTimeout(() => instructionMessage.delete().catch(() => {}), 5000);
				return;
			}

			const remainingSlots = MAX_EVIDENCE_FILES - config.evidence.length;
			if (remainingSlots <= 0) {
				// delete their msg
				await response.delete().catch(() => {});
				// show error then delete
				await instructionMessage.edit({
					embeds: [this.errorEmbed(`Maximum evidence limit reached (\`${MAX_EVIDENCE_FILES}\` files).`)]
				});
				setTimeout(() => instructionMessage.delete().catch(() => {}), 5000);
				return;
			}

			const attachments: Attachment[] = Array.from(response.attachments.values()).slice(0, remainingSlots);
			const results: string[] = [];

			// download all BEFORE deleting msg - urls die after delete
			const downloadedFiles: { attachment: Attachment; buffer: Buffer; contentType: string }[] = [];
			const downloadErrors: { attachment: Attachment; error: string }[] = [];

			for (const attachment of attachments) {
				try {
					// size check
					if (attachment.size > MAX_FILE_SIZE) {
						downloadErrors.push({
							attachment,
							error: `Too large (${(attachment.size / 1024 / 1024).toFixed(2)}MB)`
						});
						continue;
					}

					// download while url is valid
					const { buffer, contentType } = await downloadFile(attachment.url, MAX_FILE_SIZE);
					downloadedFiles.push({ attachment, buffer, contentType });
				} catch (err) {
					downloadErrors.push({
						attachment,
						error: err instanceof Error ? err.message : 'Download failed'
					});
				}
			}

			// now safe to delete
			try {
				await response.delete();
			} catch {
				// no perms maybe
			}

			// process downloaded files
			for (const { attachment, buffer, contentType } of downloadedFiles) {
				try {
					// validate file type
					if (!isAllowedFile(buffer)) {
						results.push(`❌ ${attachment.name}: File type not allowed or blocked`);
						continue;
					}

					// unique filename
					const fileId = randomUUID();
					const ext = getFileExtension(contentType, attachment.name);
					const storedFilename = `${fileId}.${ext}`;
					const storedPath = path.join(EVIDENCE_DIR, storedFilename);

					// save it
					fs.writeFileSync(storedPath, buffer);

					const evidenceFile: EvidenceFile = {
						id: fileId,
						originalName: attachment.name,
						storedPath,
						mimeType: contentType,
						size: buffer.length
					};

					config.evidence.push(evidenceFile);
					results.push(`✅ ${attachment.name}: Saved (${(buffer.length / 1024).toFixed(1)}KB)`);
				} catch (err) {
					results.push(`❌ ${attachment.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
				}
			}

			// add download errors
			for (const { attachment, error } of downloadErrors) {
				results.push(`❌ ${attachment.name}: ${error}`);
			}

			// show results then delete
			await instructionMessage.edit({
				embeds: [
					new EmbedBuilder()
						.setColor(SUCCESS_COLOR)
						.setTitle('Evidence Upload Results')
						.setDescription(results.join('\n').slice(0, 4000))
						.setFooter({ text: FOOTER_CATEGORY })
						.setTimestamp()
				]
			});
			setTimeout(() => instructionMessage.delete().catch(() => {}), 5000);

			// update menu
			const embed = await this.buildConfigurationEmbed(originalInteraction, collection, allServers, config);
			const components = this.buildConfigurationButtons(collection, allServers, config);
			await originalInteraction.editReply({
				embeds: [embed],
				components
			});
		} catch {
			// timeout
			await instructionMessage.delete().catch(() => {});
		}
	}

	private async handleSelectServers(
		buttonInteraction: import('discord.js').ButtonInteraction,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration
	) {
		// build toggle buttons
		const rows: ActionRowBuilder<ButtonBuilder>[] = [];
		let currentRow = new ActionRowBuilder<ButtonBuilder>();

		for (const server of allServers) {
			const isSelected = config.selectedServerGuildIds.has(server.guildId);
			const isMainServer = server.guildId === collection.mainGuildId;

			// get name
			let displayName = server.guildId;
			try {
				const guild = await originalInteraction.client.guilds.fetch(server.guildId);
				displayName = guild.name;
			} catch {
				// use id
			}

			// truncate + main indicator
			let label = displayName.slice(0, 70);
			if (isMainServer) {
				label = `${label} (Main)`;
			}

			const button = new ButtonBuilder()
				.setCustomId(`server_toggle_${server.guildId}`)
				.setLabel(label)
				.setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary)
				.setDisabled(isMainServer); // cant deselect main

			if (currentRow.components.length >= 5) {
				rows.push(currentRow);
				currentRow = new ActionRowBuilder<ButtonBuilder>();
			}
			currentRow.addComponents(button);
		}

		if (currentRow.components.length > 0) {
			rows.push(currentRow);
		}

		// control buttons
		const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId('server_select_all').setLabel('Select All').setStyle(ButtonStyle.Primary),
			new ButtonBuilder().setCustomId('server_deselect_all').setLabel('Deselect All').setStyle(ButtonStyle.Secondary),
			new ButtonBuilder().setCustomId('server_done').setLabel('Done').setStyle(ButtonStyle.Success)
		);
		rows.push(controlRow);

		// max 5 rows
		const limitedRows = rows.slice(0, 5);

		const serverMessage = await buttonInteraction.reply({
			embeds: [
				new EmbedBuilder()
					.setColor(EMBED_COLOR)
					.setTitle('Select Servers')
					.setDescription(
						'Select servers to ban in. Click to toggle, green = selected.\n\n**Note:** The main server is always selected and cannot be deselected.'
					)
					.setFooter({ text: FOOTER_CATEGORY })
					.setTimestamp()
			],
			components: limitedRows,
			ephemeral: true,
			fetchReply: true
		});

		const serverCollector = serverMessage.createMessageComponentCollector({
			componentType: ComponentType.Button,
			time: 120000
		});

		serverCollector.on('collect', async (serverButtonInteraction) => {
			if (serverButtonInteraction.customId === 'server_done') {
				serverCollector.stop();
				await serverButtonInteraction.update({
					embeds: [
						new EmbedBuilder()
							.setColor(SUCCESS_COLOR)
							.setTitle('Servers Selected')
							.setDescription(`Selected \`${config.selectedServerGuildIds.size}\` server(s).`)
							.setFooter({ text: FOOTER_CATEGORY })
							.setTimestamp()
					],
					components: []
				});

				// update menu
				const embed = await this.buildConfigurationEmbed(originalInteraction, collection, allServers, config);
				const components = this.buildConfigurationButtons(collection, allServers, config);
				await originalInteraction.editReply({
					embeds: [embed],
					components
				});
				return;
			}

			if (serverButtonInteraction.customId === 'server_select_all') {
				// select all
				for (const server of allServers) {
					config.selectedServerGuildIds.add(server.guildId);
				}
			} else if (serverButtonInteraction.customId === 'server_deselect_all') {
				// deselect all except main
				config.selectedServerGuildIds.clear();
				config.selectedServerGuildIds.add(collection.mainGuildId);
			} else if (serverButtonInteraction.customId.startsWith('server_toggle_')) {
				const guildId = serverButtonInteraction.customId.replace('server_toggle_', '');

				// cant toggle main
				if (guildId === collection.mainGuildId) {
					await serverButtonInteraction.reply({
						embeds: [this.errorEmbed('The main server cannot be deselected.')],
						ephemeral: true
					});
					return;
				}

				if (config.selectedServerGuildIds.has(guildId)) {
					config.selectedServerGuildIds.delete(guildId);
				} else {
					config.selectedServerGuildIds.add(guildId);
				}
			}

			// rebuild buttons
			const updatedRows: ActionRowBuilder<ButtonBuilder>[] = [];
			let updatedCurrentRow = new ActionRowBuilder<ButtonBuilder>();

			for (const server of allServers) {
				const isSelected = config.selectedServerGuildIds.has(server.guildId);
				const isMainServer = server.guildId === collection.mainGuildId;

				let displayName = server.guildId;
				try {
					const guild = await originalInteraction.client.guilds.fetch(server.guildId);
					displayName = guild.name;
				} catch {
					// use id
				}

				let label = displayName.slice(0, 70);
				if (isMainServer) {
					label = `${label} (Main)`;
				}

				const button = new ButtonBuilder()
					.setCustomId(`server_toggle_${server.guildId}`)
					.setLabel(label)
					.setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary)
					.setDisabled(isMainServer);

				if (updatedCurrentRow.components.length >= 5) {
					updatedRows.push(updatedCurrentRow);
					updatedCurrentRow = new ActionRowBuilder<ButtonBuilder>();
				}
				updatedCurrentRow.addComponents(button);
			}

			if (updatedCurrentRow.components.length > 0) {
				updatedRows.push(updatedCurrentRow);
			}

			const updatedControlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId('server_select_all').setLabel('Select All').setStyle(ButtonStyle.Primary),
				new ButtonBuilder().setCustomId('server_deselect_all').setLabel('Deselect All').setStyle(ButtonStyle.Secondary),
				new ButtonBuilder().setCustomId('server_done').setLabel('Done').setStyle(ButtonStyle.Success)
			);
			updatedRows.push(updatedControlRow);

			const updatedLimitedRows = updatedRows.slice(0, 5);

			await serverButtonInteraction.update({
				embeds: [
					new EmbedBuilder()
						.setColor(EMBED_COLOR)
						.setTitle('Select Servers')
						.setDescription(
							'Select servers to ban in. Click to toggle, green = selected.\n\n**Note:** The main server is always selected and cannot be deselected.'
						)
						.setFooter({ text: FOOTER_CATEGORY })
						.setTimestamp()
				],
				components: updatedLimitedRows
			});
		});
	}

	private async handleConfirmBan(
		buttonInteraction: import('discord.js').ButtonInteraction,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		_allServers: ServerInfo[],
		config: BanConfiguration
	) {
		console.log(`[ShareBan] Confirm ban initiated for user ${config.targetUser.id}`);

		await buttonInteraction.update({
			embeds: [this.loadingEmbed('Applying ban to all selected servers. This may take a moment…')],
			components: []
		});

		const results: { guildId: string; guildName: string; success: boolean; error?: string }[] = [];

		// get server names for dm
		const serverNames: string[] = [];
		for (const guildId of config.selectedServerGuildIds) {
			try {
				const guild = await originalInteraction.client.guilds.fetch(guildId);
				serverNames.push(guild.name);
			} catch {
				serverNames.push(`Server (${guildId})`);
			}
		}

		// dm user if enabled
		if (config.dmUser) {
			try {
				const serverList = serverNames.map((name) => `• ${name}`).join('\n');

				const dmEmbed = new EmbedBuilder()
					.setColor(ERROR_COLOR)
					.setTitle('You have been banned')
					.setDescription(`You have been banned from the following servers:`)
					.addFields(
						{
							name: 'Servers',
							value: serverList.slice(0, 1024) || 'No servers listed'
						},
						{
							name: 'Reason',
							value: config.userFacingReason || config.reason || 'No reason provided'
						}
					)
					.setFooter({ text: FOOTER_CATEGORY })
					.setTimestamp();

				console.log(`[ShareBan] Sending DM to user ${config.targetUser.id}`);
				await config.targetUser.send({ embeds: [dmEmbed] });
				console.log(`[ShareBan] DM sent successfully`);
			} catch (error) {
				console.log(`[ShareBan] Failed to DM user: ${error}`);
				// dms disabled probably
			}
		}

		// ban from all selected
		for (const guildId of config.selectedServerGuildIds) {
			try {
				const guild = await originalInteraction.client.guilds.fetch(guildId);

				await guild.members.ban(config.targetUser.id, {
					reason: `[ShareBan] ${config.reason}`
				});

				results.push({
					guildId,
					guildName: guild.name,
					success: true
				});
			} catch (err) {
				let guildName = guildId;
				try {
					const guild = await originalInteraction.client.guilds.fetch(guildId);
					guildName = guild.name;
				} catch {
					// use id
				}

				results.push({
					guildId,
					guildName,
					success: false,
					error: err instanceof Error ? err.message : 'Unknown error'
				});
			}
		}

		// create db record
		const ban = Ban.create({
			userId: config.targetUser.id,
			collectionId: config.collectionId,
			moderatorId: originalInteraction.user.id,
			moderatorGuildId: originalInteraction.guild!.id,
			reason: config.reason,
			userFacingReason: config.userFacingReason || null,
			privatiseReason: config.privatiseReason,
			moderatorsInvolved: config.moderatorsInvolved
		});

		console.log(`[CMD] /shareban: COMPLETED by userId=${originalInteraction.user.id} banId=${ban.id} targetUserId=${config.targetUser.id}`);

		// audit log
		const successfulServerIds = results.filter((r) => r.success).map((r) => r.guildId);
		const failedServerIds = results.filter((r) => !r.success).map((r) => r.guildId);

		logAction({
			collectionId: config.collectionId,
			action: 'ban.create',
			performedBy: originalInteraction.user.id,
			details: {
				banId: ban.id,
				userId: config.targetUser.id,
				reason: config.reason,
				privatiseReason: config.privatiseReason,
				serverIds: successfulServerIds,
				moderatorCount: config.moderatorsInvolved.length,
				evidenceCount: config.evidence.length,
				serverCount: successfulServerIds.length
			}
		});

		// log failures if any
		if (failedServerIds.length > 0) {
			logAction({
				collectionId: config.collectionId,
				action: 'ban.sync.failed',
				performedBy: originalInteraction.user.id,
				details: {
					banId: ban.id,
					userId: config.targetUser.id,
					serverIds: failedServerIds,
					serverCount: failedServerIds.length,
					errors: results.filter((r) => !r.success).map((r) => ({ guildId: r.guildId, error: r.error }))
				}
			});
		}

		// results embed
		const successCount = results.filter((r) => r.success).length;
		const failCount = results.filter((r) => !r.success).length;

		const resultsEmbed = new EmbedBuilder()
			.setTitle('ShareBan Complete')
			.setColor(failCount === 0 ? SUCCESS_COLOR : failCount === results.length ? ERROR_COLOR : WARNING_COLOR)
			.setDescription(`Banned **${config.targetUser.tag}**\nUser ID: \`${config.targetUser.id}\``)
			.addFields(
				{
					name: 'Collection',
					value: `\`${collection.name}\``,
					inline: true
				},
				{
					name: 'Ban ID',
					value: `\`${ban.id}\``,
					inline: true
				},
				{
					name: 'Results',
					value: `\`${successCount}\` succeeded\n\`${failCount}\` failed`,
					inline: true
				},
				{
					name: 'Server Details',
					value: results
						.map((r) => `${r.success ? '✅' : '❌'} ${r.guildName}${r.error ? ` - \`${r.error}\`` : ''}`)
						.join('\n')
						.slice(0, 1024),
					inline: false
				}
			)
			.setFooter({
				text: `${FOOTER_CATEGORY} • Executed by ${originalInteraction.user.tag}`
			})
			.setTimestamp();

		await originalInteraction.editReply({
			content: null,
			embeds: [resultsEmbed],
			components: []
		});
	}

	// toggle setting handler
	private async handleToggleSetting(
		buttonInteraction: import('discord.js').ButtonInteraction,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		allServers: ServerInfo[],
		config: BanConfiguration,
		field: 'privatiseReason' | 'dmUser',
		displayName: string,
		description: string
	) {
		const currentValue = config[field];
		let pendingValue = currentValue;

		const buildToggleEmbed = (pending: boolean) =>
			new EmbedBuilder()
				.setColor(WARNING_COLOR)
				.setTitle(`Toggle: ${displayName}`)
				.setDescription(description)
				.addFields(
					{
						name: 'Current Value',
						value: currentValue ? '`Enabled`' : '`Disabled`',
						inline: true
					},
					{
						name: 'New Value',
						value: pending ? '`Enabled`' : '`Disabled`',
						inline: true
					}
				)
				.setFooter({ text: FOOTER_CATEGORY })
				.setTimestamp();

		const buildToggleButtons = (pending: boolean) => [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`shareban:toggle-${field}:enable`)
					.setLabel('Enable')
					.setStyle(pending ? ButtonStyle.Success : ButtonStyle.Secondary),
				new ButtonBuilder()
					.setCustomId(`shareban:toggle-${field}:disable`)
					.setLabel('Disable')
					.setStyle(!pending ? ButtonStyle.Danger : ButtonStyle.Secondary)
			),
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(`shareban:toggle-${field}:save`).setLabel('Save').setStyle(ButtonStyle.Success).setEmoji('💾'),
				new ButtonBuilder().setCustomId(`shareban:toggle-${field}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
			)
		];

		const reply = await buttonInteraction.reply({
			embeds: [buildToggleEmbed(pendingValue)],
			components: buildToggleButtons(pendingValue),
			ephemeral: true,
			fetchReply: true
		});

		const collector = reply.createMessageComponentCollector({
			filter: (i) => i.user.id === buttonInteraction.user.id && i.customId.startsWith(`shareban:toggle-${field}:`),
			time: 60_000
		});

		collector.on('collect', async (i) => {
			if (!i.isButton()) return;

			if (i.customId.endsWith(':enable')) {
				pendingValue = true;
				await i.update({
					embeds: [buildToggleEmbed(pendingValue)],
					components: buildToggleButtons(pendingValue)
				});
			} else if (i.customId.endsWith(':disable')) {
				pendingValue = false;
				await i.update({
					embeds: [buildToggleEmbed(pendingValue)],
					components: buildToggleButtons(pendingValue)
				});
			} else if (i.customId.endsWith(':save')) {
				config[field] = pendingValue;
				console.log(`[CMD] /shareban: userId=${originalInteraction.user.id} set ${field}=${pendingValue}`);
				collector.stop('saved');
				await i.deferUpdate();
				await buttonInteraction.deleteReply();
				// update menu
				const embed = await this.buildConfigurationEmbed(originalInteraction, collection, allServers, config);
				const components = this.buildConfigurationButtons(collection, allServers, config);
				await originalInteraction.editReply({
					embeds: [embed],
					components
				});
			} else if (i.customId.endsWith(':cancel')) {
				console.log(`[CMD] /shareban: userId=${originalInteraction.user.id} cancelled toggle ${field}`);
				collector.stop('cancelled');
				await i.deferUpdate();
				await buttonInteraction.deleteReply();
			}
		});
	}

	// helper embeds
	private errorEmbed(message: string): EmbedBuilder {
		return new EmbedBuilder().setColor(ERROR_COLOR).setTitle('Error').setDescription(message).setFooter({ text: FOOTER_CATEGORY }).setTimestamp();
	}

	private timeoutEmbed(): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(ERROR_COLOR)
			.setTitle('Timed Out')
			.setDescription('This interaction has expired. Please run the command again.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}

	private cancelledEmbed(): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(WARNING_COLOR)
			.setTitle('Cancelled')
			.setDescription('The ban has been cancelled. No action was taken.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}

	private loadingEmbed(message: string): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('Working…')
			.setDescription(message)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}
}

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
	TextInputStyle
} from 'discord.js';
import { Collection as BanCollection } from '../database/models/collection';
import { Ban, EvidenceEntry } from '../database/models/ban';
import { Server } from '../database/models/server';
import { Moderator } from '../database/models/moderator';
import { isValidId, RecordNotFoundError } from '../database/models/shared';
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
	webp: [[0x52, 0x49, 0x46, 0x46]], // riff header
	bmp: [[0x42, 0x4d]],
	// documents
	pdf: [[0x25, 0x50, 0x44, 0x46]],
	// videos
	mp4: [[0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]], // ftyp header
	webm: [[0x1a, 0x45, 0xdf, 0xa3]],
	// text (utf-8 bom or ascii)
	txt: [[0xef, 0xbb, 0xbf]] // utf-8 bom
};

// blocked executable sigs
const BLOCKED_MAGIC_BYTES: number[][] = [
	[0x4d, 0x5a], // windows exe/dll
	[0x7f, 0x45, 0x4c, 0x46], // linux elf
	[0xca, 0xfe, 0xba, 0xbe], // macho
	[0xcf, 0xfa, 0xed, 0xfe], // macho 64bit
	[0x50, 0x4b, 0x03, 0x04] // zip (jar/apk/etc)
];

interface EditBanConfiguration {
	ban: Ban;
	reason: string;
	privatiseReason: boolean;
	moderatorsInvolved: string[];
	evidence: EvidenceEntry[];
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
	description: 'Edit an existing shareban record'
})
export class EditShareBanCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName('edit-shareban')
				.setDescription(this.description)
				.addStringOption((option) => option.setName('id').setDescription('The ban ID to edit').setRequired(true))
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

		console.log(`[CMD] /edit-shareban initiated by userId=${executorId} for banId=${banId} in guildId=${interaction.guildId}`);

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
				embeds: [this.errorEmbed('You must be a moderator or owner of this collection to edit bans.', 'Permission denied')],
				ephemeral: true
			});
		}

		// init config with current ban data
		const config: EditBanConfiguration = {
			ban,
			reason: ban.reason || '',
			privatiseReason: ban.privatiseReason,
			moderatorsInvolved: [...ban.moderatorsInvolved],
			evidence: [...ban.evidence]
		};

		await this.showConfigurationMenu(interaction, collection, config);
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

	private async showConfigurationMenu(interaction: Command.ChatInputCommandInteraction, collection: BanCollection, config: EditBanConfiguration) {
		const embed = await this.buildConfigurationEmbed(interaction, collection, config);
		const components = this.buildConfigurationButtons(config);

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
					embeds: [this.errorEmbed('This interaction is not for you.', 'Interaction denied')],
					ephemeral: true
				});
				return;
			}

			const customId = buttonInteraction.customId;

			if (customId === 'editban_reason') {
				await this.handleReasonModal(buttonInteraction, interaction, collection, config);
			} else if (customId === 'editban_privatise') {
				await this.handleToggleSetting(
					buttonInteraction,
					interaction,
					collection,
					config,
					'privatiseReason',
					'Privatise Reason',
					'When enabled, the ban reason will be hidden from public logs and only visible to moderators.'
				);
			} else if (customId === 'editban_moderators') {
				await this.handleModeratorsSelection(buttonInteraction, interaction, collection, config);
			} else if (customId === 'editban_evidence') {
				await this.handleEvidenceUpload(buttonInteraction, interaction, collection, config);
			} else if (customId === 'editban_confirm') {
				collector.stop();
				await this.handleConfirmEdit(buttonInteraction, interaction, collection, config);
			} else if (customId === 'editban_cancel') {
				console.log(`[CMD] /edit-shareban: CANCELLED by userId=${interaction.user.id}`);
				collector.stop();
				await buttonInteraction.update({
					embeds: [this.cancelledEmbed()],
					components: []
				});
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				console.log(`[CMD] /edit-shareban: TIMED OUT for userId=${interaction.user.id}`);
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

	private async buildConfigurationEmbed(
		interaction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		config: EditBanConfiguration
	): Promise<EmbedBuilder> {
		// try to resolve user
		let targetUserTag = `User ID: ${config.ban.userId}`;
		try {
			const user = await interaction.client.users.fetch(config.ban.userId);
			targetUserTag = user.tag;
		} catch {
			// not found, use id
		}

		const embed = new EmbedBuilder()
			.setTitle('Edit ShareBan')
			.setColor(EMBED_COLOR)
			.setDescription(`Editing ban for **${targetUserTag}**\nBan ID: \`${config.ban.id}\``)
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
					name: 'Ban Status',
					value: config.ban.active ? '`Active`' : '`Inactive`',
					inline: true
				},
				{
					name: 'Reason (Internal)',
					value: config.reason ? `\`\`\`${config.reason.slice(0, 900)}\`\`\`` : '*Not set*',
					inline: false
				},
				{
					name: 'User-Facing Reason',
					value: '`Cannot be edited (DM already sent)`',
					inline: false
				},
				{
					name: 'Privatise Reason',
					value: config.privatiseReason ? '`Enabled`' : '`Disabled`',
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
							? config.evidence.map((e) => `• \`${e.ref}\` (\`${e.id.slice(0, 8)}\`)`).join('\n')
							: `*No evidence attached (\`0/${MAX_EVIDENCE_FILES}\`)*`,
					inline: false
				},
				{
					name: 'Original Ban',
					value: `<t:${Math.floor(new Date(config.ban.timestamp).getTime() / 1000)}:F>`,
					inline: false
				}
			)
			.setFooter({
				text: `${FOOTER_CATEGORY}`
			})
			.setTimestamp();

		return embed;
	}

	private buildConfigurationButtons(config: EditBanConfiguration): ActionRowBuilder<ButtonBuilder>[] {
		const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId('editban_reason')
				.setLabel('Set Reason')
				.setStyle(config.reason ? ButtonStyle.Success : ButtonStyle.Secondary)
				.setEmoji('📝'),
			new ButtonBuilder()
				.setCustomId('editban_privatise')
				.setLabel(config.privatiseReason ? 'Privatised' : 'Public')
				.setStyle(config.privatiseReason ? ButtonStyle.Success : ButtonStyle.Danger)
				.setEmoji(config.privatiseReason ? '🔒' : '🔓')
		);

		const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId('editban_moderators')
				.setLabel(`Moderators (${config.moderatorsInvolved.length})`)
				.setStyle(ButtonStyle.Primary)
				.setEmoji('👥'),
			new ButtonBuilder()
				.setCustomId('editban_evidence')
				.setLabel(`Evidence (${config.evidence.length}/${MAX_EVIDENCE_FILES})`)
				.setStyle(ButtonStyle.Primary)
				.setEmoji('📎')
				.setDisabled(config.evidence.length >= MAX_EVIDENCE_FILES)
		);

		// can confirm?
		const canConfirm = config.reason.length > 0;

		const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId('editban_confirm')
				.setLabel('Update Ban')
				.setStyle(ButtonStyle.Success)
				.setEmoji('💾')
				.setDisabled(!canConfirm),
			new ButtonBuilder().setCustomId('editban_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('✖️')
		);

		return [row1, row2, row3];
	}

	private async handleReasonModal(
		buttonInteraction: import('discord.js').ButtonInteraction,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		config: EditBanConfiguration
	) {
		const modal = new ModalBuilder()
			.setCustomId('editban_reason_modal')
			.setTitle('Edit Ban Reason')
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
				filter: (i) => i.customId === 'editban_reason_modal' && i.user.id === buttonInteraction.user.id
			});

			config.reason = modalSubmit.fields.getTextInputValue('reason_input');

			const embed = await this.buildConfigurationEmbed(originalInteraction, collection, config);
			const components = this.buildConfigurationButtons(config);

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
		config: EditBanConfiguration
	) {
		const channel = buttonInteraction.channel;
		if (!channel || !channel.isTextBased() || channel.isDMBased()) {
			await buttonInteraction.reply({
				embeds: [this.errorEmbed('Cannot manage moderators in this channel type.', 'Invalid channel')],
				ephemeral: true
			});
			return;
		}

		await buttonInteraction.deferUpdate();

		// mod list
		const embed = this.buildModeratorsListEmbed(config);
		const components = this.buildModeratorsButtons();

		const modsMessage = await channel.send({
			embeds: [embed],
			components
		});

		const collector = modsMessage.createMessageComponentCollector({
			filter: (i) => i.user.id === buttonInteraction.user.id && i.customId.startsWith('editban:mods:'),
			time: 300_000 // 5 minutes
		});

		collector.on('collect', async (i) => {
			if (i.customId === 'editban:mods:add') {
				collector.stop('action');
				await i.deferUpdate();
				await this.handleAddModeratorsFlow(i, modsMessage, originalInteraction, collection, config);
			} else if (i.customId === 'editban:mods:remove') {
				if (config.moderatorsInvolved.length === 0) {
					await i.reply({
						embeds: [this.errorEmbed('There are no moderators to remove.', 'No moderators')],
						ephemeral: true
					});
					return;
				}
				collector.stop('action');
				await i.deferUpdate();
				await this.handleRemoveModeratorsFlow(i, modsMessage, originalInteraction, collection, config);
			} else if (i.customId === 'editban:mods:done') {
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

				// update menu
				const mainEmbed = await this.buildConfigurationEmbed(originalInteraction, collection, config);
				const mainComponents = this.buildConfigurationButtons(config);
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

	private buildModeratorsListEmbed(config: EditBanConfiguration): EmbedBuilder {
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
				new ButtonBuilder().setCustomId('editban:mods:add').setLabel('Add Moderators').setStyle(ButtonStyle.Success).setEmoji('➕'),
				new ButtonBuilder().setCustomId('editban:mods:remove').setLabel('Remove Moderators').setStyle(ButtonStyle.Danger).setEmoji('➖'),
				new ButtonBuilder().setCustomId('editban:mods:done').setLabel('Done').setStyle(ButtonStyle.Secondary).setEmoji('✅')
			)
		];
	}

	private async handleAddModeratorsFlow(
		i: import('discord.js').MessageComponentInteraction,
		modsMessage: Message,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		config: EditBanConfiguration
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
			new ButtonBuilder().setCustomId('editban:mods:add:start').setLabel('Start').setStyle(ButtonStyle.Success).setEmoji('▶️'),
			new ButtonBuilder().setCustomId('editban:mods:add:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
		);

		const channel = i.channel as GuildTextBasedChannel;
		const instructionMessage = await channel.send({
			embeds: [instructionEmbed],
			components: [startRow]
		});

		const buttonCollector = instructionMessage.createMessageComponentCollector({
			filter: (btn) => btn.user.id === i.user.id && btn.customId.startsWith('editban:mods:add:'),
			time: 60_000,
			max: 1
		});

		buttonCollector.on('collect', async (btn) => {
			if (btn.customId === 'editban:mods:add:cancel') {
				await btn.deferUpdate();
				await instructionMessage.delete().catch(() => {});
				await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, config);
				return;
			}

			await btn.deferUpdate();
			await this.collectModeratorsToAdd(instructionMessage, modsMessage, originalInteraction, collection, config);
		});

		buttonCollector.on('end', async (collected, reason) => {
			if (reason === 'time' && collected.size === 0) {
				await instructionMessage.delete().catch(() => {});
				await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, config);
			}
		});
	}

	private async collectModeratorsToAdd(
		instructionMessage: Message,
		modsMessage: Message,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		config: EditBanConfiguration
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

			console.log(`[EditShareBan] Added ${addedMods.length} moderators, total: ${config.moderatorsInvolved.length}`);

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

			await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, config);
		});
	}

	private async handleRemoveModeratorsFlow(
		i: import('discord.js').MessageComponentInteraction,
		modsMessage: Message,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		config: EditBanConfiguration
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
			new ButtonBuilder().setCustomId('editban:mods:remove:start').setLabel('Start').setStyle(ButtonStyle.Success).setEmoji('▶️'),
			new ButtonBuilder().setCustomId('editban:mods:remove:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
		);

		const channel = i.channel as GuildTextBasedChannel;
		const instructionMessage = await channel.send({
			embeds: [instructionEmbed],
			components: [startRow]
		});

		const buttonCollector = instructionMessage.createMessageComponentCollector({
			filter: (btn) => btn.user.id === i.user.id && btn.customId.startsWith('editban:mods:remove:'),
			time: 60_000,
			max: 1
		});

		buttonCollector.on('collect', async (btn) => {
			if (btn.customId === 'editban:mods:remove:cancel') {
				await btn.deferUpdate();
				await instructionMessage.delete().catch(() => {});
				await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, config);
				return;
			}

			await btn.deferUpdate();
			await this.collectModeratorsToRemove(instructionMessage, modsMessage, originalInteraction, collection, config);
		});

		buttonCollector.on('end', async (collected, reason) => {
			if (reason === 'time' && collected.size === 0) {
				await instructionMessage.delete().catch(() => {});
				await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, config);
			}
		});
	}

	private async collectModeratorsToRemove(
		instructionMessage: Message,
		modsMessage: Message,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		config: EditBanConfiguration
	): Promise<void> {
		const collectingEmbed = new EmbedBuilder()
			.setColor(SUCCESS_COLOR)
			.setTitle('📝 Now Accepting Removals')
			.setDescription('**Start pinging/typing moderator IDs to remove!**\n\n' + 'Type **stop**, **done**, or any other text to finish.')
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

			const idsToRemove: string[] = [];
			const userMatches = [...content.matchAll(USER_MENTION_REGEX)];
			for (const match of userMatches) {
				idsToRemove.push(match[1]);
			}

			const mentionedIds = new Set(userMatches.map((m) => m[1]));
			const rawIdMatches = [...content.matchAll(SNOWFLAKE_REGEX)];
			for (const match of rawIdMatches) {
				const id = match[1];
				if (!mentionedIds.has(id)) {
					idsToRemove.push(id);
				}
			}

			for (const id of idsToRemove) {
				const index = config.moderatorsInvolved.indexOf(id);
				if (index !== -1) {
					config.moderatorsInvolved.splice(index, 1);
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
			console.log(`[EditShareBan] Removed ${removedMods.length} moderators, remaining: ${config.moderatorsInvolved.length}`);

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

			await this.refreshModeratorsMenu(modsMessage, originalInteraction, collection, config);
		});
	}

	private async refreshModeratorsMenu(
		modsMessage: Message,
		_originalInteraction: Command.ChatInputCommandInteraction,
		_collection: BanCollection,
		config: EditBanConfiguration
	): Promise<void> {
		const embed = this.buildModeratorsListEmbed(config);
		const components = this.buildModeratorsButtons();
		await modsMessage.edit({ embeds: [embed], components });
	}

	private async handleEvidenceUpload(
		buttonInteraction: import('discord.js').ButtonInteraction,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		config: EditBanConfiguration
	) {
		const channel = buttonInteraction.channel;
		if (!channel || !channel.isTextBased() || channel.isDMBased()) {
			await buttonInteraction.reply({
				embeds: [this.errorEmbed('Cannot upload evidence in this channel type.', 'Invalid channel')],
				ephemeral: true
			});
			return;
		}

		await buttonInteraction.deferUpdate();

		const instructionEmbed = new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('Upload Evidence')
			.setDescription(
				`Upload evidence files for this ban.\n\n` +
					`**Allowed:** Images, videos, PDFs, text files\n` +
					`**Max Size:** ${MAX_FILE_SIZE / 1024 / 1024}MB per file\n` +
					`**Limit:** ${MAX_EVIDENCE_FILES - config.evidence.length} more file(s)\n\n` +
					`Upload your files in the next message, then type **done** when finished.`
			)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		const instructionMessage = await (channel as GuildTextBasedChannel).send({
			embeds: [instructionEmbed]
		});

		try {
			const collected = await channel.awaitMessages({
				filter: (m) => m.author.id === originalInteraction.user.id,
				max: 1,
				time: 120_000,
				errors: ['time']
			});

			const message = collected.first();
			if (!message) return;

			if (message.content.toLowerCase().trim() === 'done' && message.attachments.size === 0) {
				await message.delete().catch(() => {});
				await instructionMessage.delete().catch(() => {});
				return;
			}

			const attachments = Array.from(message.attachments.values());
			const results: string[] = [];
			const downloadErrors: { attachment: Attachment; error: string }[] = [];

			for (const attachment of attachments) {
				if (config.evidence.length >= MAX_EVIDENCE_FILES) {
					results.push(`❌ ${attachment.name}: Evidence limit reached (${MAX_EVIDENCE_FILES})`);
					continue;
				}

				try {
					const { buffer, contentType } = await downloadFile(attachment.url, MAX_FILE_SIZE);

					if (!isAllowedFile(buffer)) {
						downloadErrors.push({ attachment, error: 'File type not allowed or potentially unsafe' });
						continue;
					}

					const ext = getFileExtension(contentType, attachment.name);
					const evidenceId = randomUUID();
					const filename = `${evidenceId}.${ext}`;
					const storedPath = path.join(EVIDENCE_DIR, filename);

					fs.writeFileSync(storedPath, buffer);

					const evidenceEntry: EvidenceEntry = {
						id: evidenceId,
						type: contentType.startsWith('image/') ? 'image' : contentType.startsWith('video/') ? 'image' : 'text',
						storage: 'external',
						ref: filename,
						sizeBytes: buffer.length
					};

					config.evidence.push(evidenceEntry);
					results.push(`✅ ${attachment.name} uploaded successfully (\`${evidenceId.slice(0, 8)}\`)`);
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : 'Unknown error';
					downloadErrors.push({ attachment, error: errorMsg });
				}
			}

			await message.delete().catch(() => {});

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
			const embed = await this.buildConfigurationEmbed(originalInteraction, collection, config);
			const components = this.buildConfigurationButtons(config);
			await originalInteraction.editReply({
				embeds: [embed],
				components
			});
		} catch {
			// timeout
			await instructionMessage.delete().catch(() => {});
		}
	}

	private async handleConfirmEdit(
		buttonInteraction: import('discord.js').ButtonInteraction,
		originalInteraction: Command.ChatInputCommandInteraction,
		collection: BanCollection,
		config: EditBanConfiguration
	) {
		console.log(`[EditShareBan] Confirm edit initiated for banId ${config.ban.id}`);

		await buttonInteraction.update({
			embeds: [this.loadingEmbed('Updating ban record...')],
			components: []
		});

		// update the ban record
		config.ban.reason = config.reason;
		config.ban.privatiseReason = config.privatiseReason;
		config.ban.moderatorsInvolved = config.moderatorsInvolved;
		config.ban.evidence = config.evidence;

		try {
			config.ban.save();

			console.log(
				`[CMD] /edit-shareban: COMPLETED by userId=${originalInteraction.user.id} banId=${config.ban.id} targetUserId=${config.ban.userId}`
			);

			// audit log
			logAction({
				collectionId: config.ban.collectionId,
				action: 'ban.edit',
				performedBy: originalInteraction.user.id,
				details: {
					banId: config.ban.id,
					userId: config.ban.userId,
					updatedFields: ['reason', 'privatiseReason', 'moderatorsInvolved', 'evidence'],
					moderatorCount: config.moderatorsInvolved.length,
					evidenceCount: config.evidence.length
				}
			});

			// try resolve user for embed
			let targetUserTag = `User ID: ${config.ban.userId}`;
			try {
				const user = await originalInteraction.client.users.fetch(config.ban.userId);
				targetUserTag = user.tag;
			} catch {
				// not found, use id
			}

			const resultEmbed = new EmbedBuilder()
				.setTitle('Ban Updated Successfully')
				.setColor(SUCCESS_COLOR)
				.setDescription(`Updated ban for **${targetUserTag}**\nBan ID: \`${config.ban.id}\``)
				.addFields(
					{
						name: 'Collection',
						value: `\`${collection.name}\``,
						inline: true
					},
					{
						name: 'Reason',
						value: config.reason.slice(0, 1024),
						inline: false
					},
					{
						name: 'Privatise Reason',
						value: config.privatiseReason ? '`Enabled`' : '`Disabled`',
						inline: true
					},
					{
						name: 'Moderators Involved',
						value: config.moderatorsInvolved.length > 0 ? `\`${config.moderatorsInvolved.length}\` moderators` : '*None*',
						inline: true
					},
					{
						name: 'Evidence',
						value: config.evidence.length > 0 ? `\`${config.evidence.length}\` file(s)` : '*None*',
						inline: true
					}
				)
				.setFooter({
					text: `${FOOTER_CATEGORY} • Updated by ${originalInteraction.user.tag}`
				})
				.setTimestamp();

			await originalInteraction.editReply({
				content: null,
				embeds: [resultEmbed],
				components: []
			});
		} catch (error) {
			console.error(`[EditShareBan] Error saving ban:`, error);
			await originalInteraction.editReply({
				embeds: [this.errorEmbed('Failed to update the ban record. Please try again.', 'Update failed')],
				components: []
			});
		}
	}

	// toggle setting handler
	private async handleToggleSetting(
		buttonInteraction: import('discord.js').ButtonInteraction,
		_originalInteraction: Command.ChatInputCommandInteraction,
		_collection: BanCollection,
		config: EditBanConfiguration,
		field: 'privatiseReason',
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
					.setCustomId(`editban:toggle-${field}:enable`)
					.setLabel('Enable')
					.setStyle(pending ? ButtonStyle.Success : ButtonStyle.Secondary),
				new ButtonBuilder()
					.setCustomId(`editban:toggle-${field}:disable`)
					.setLabel('Disable')
					.setStyle(!pending ? ButtonStyle.Danger : ButtonStyle.Secondary)
			),
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(`editban:toggle-${field}:save`).setLabel('Save').setStyle(ButtonStyle.Success).setEmoji('💾'),
				new ButtonBuilder().setCustomId(`editban:toggle-${field}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
			)
		];

		const reply = await buttonInteraction.reply({
			embeds: [buildToggleEmbed(pendingValue)],
			components: buildToggleButtons(pendingValue),
			ephemeral: true,
			fetchReply: true
		});

		const collector = reply.createMessageComponentCollector({
			filter: (i) => i.user.id === buttonInteraction.user.id && i.customId.startsWith(`editban:toggle-${field}:`),
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
				console.log(`[CMD] /edit-shareban: userId=${_originalInteraction.user.id} set ${field}=${pendingValue}`);
				collector.stop('saved');
				await i.deferUpdate();
				await buttonInteraction.deleteReply();
				// update menu
				const embed = await this.buildConfigurationEmbed(_originalInteraction, _collection, config);
				const components = this.buildConfigurationButtons(config);
				await _originalInteraction.editReply({
					embeds: [embed],
					components
				});
			} else if (i.customId.endsWith(':cancel')) {
				console.log(`[CMD] /edit-shareban: userId=${_originalInteraction.user.id} cancelled toggle ${field}`);
				collector.stop('cancelled');
				await i.deferUpdate();
				await buttonInteraction.deleteReply();
			}
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
			.setDescription('This interaction has expired. Please run the command again.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}

	private cancelledEmbed(): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(WARNING_COLOR)
			.setTitle('Cancelled')
			.setDescription('The ban edit has been cancelled. No changes were made.')
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

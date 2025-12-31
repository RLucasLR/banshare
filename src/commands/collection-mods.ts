import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	InteractionContextType,
	Message,
	PermissionFlagsBits,
	type ButtonInteraction,
	type GuildTextBasedChannel,
	type MessageComponentInteraction
} from 'discord.js';
import { Collection, Moderator, RecordNotFoundError } from '../database/models';
import { logAction } from '../lib/utils';

const FOOTER_CATEGORY = 'BanShare • Collections';
const EMBED_COLOR = 0x5865f2; // blurple
const ERROR_COLOR = 0xed4245; // red
const SUCCESS_COLOR = 0x57f287; // green
const WARNING_COLOR = 0xfee75c; // yellow

// regex
const USER_MENTION_REGEX = /<@!?(\d{17,20})>/g;
const ROLE_MENTION_REGEX = /<@&(\d{17,20})>/g;
const SNOWFLAKE_REGEX = /\b(\d{17,20})\b/g;

@ApplyOptions<Command.Options>({
	description: 'Manage moderators for your collection'
})
export class CollectionModsCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: 'collection-mods',
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

		console.log(`[CMD] /collection-mods initiated by userId=${interaction.user.id} in guildId=${interaction.guildId}`);

		// check perms
		const member = interaction.member;
		const isGuildOwner = interaction.guild?.ownerId === interaction.user.id;
		const hasAdminPermission =
			member && 'permissions' in member && typeof member.permissions !== 'string' && member.permissions.has(PermissionFlagsBits.Administrator);

		if (!isGuildOwner && !hasAdminPermission) {
			await interaction.reply({
				embeds: [this.errorEmbed('You must be the **server owner** or have **Administrator** permission to manage collection moderators.')],
				ephemeral: true
			});
			return;
		}

		// find collection (must be owner)
		let collection: Collection;
		try {
			collection = Collection.getByMainGuildId(interaction.guildId);
		} catch (error) {
			if (error instanceof RecordNotFoundError) {
				await interaction.reply({
					embeds: [
						this.errorEmbed(
							'This server does not own a collection. This command can only be used in the **owner server** of a collection.'
						)
					],
					ephemeral: true
				});
				return;
			}
			throw error;
		}

		await this.showModeratorsList(interaction, collection);
	}

	private async showModeratorsList(interaction: Command.ChatInputCommandInteraction, collection: Collection): Promise<void> {
		const moderators = Moderator.listByCollection(collection.id);
		const embed = this.buildModeratorsListEmbed(collection, moderators);
		const components = this.buildMainButtons();

		const response = await interaction.reply({
			embeds: [embed],
			components,
			ephemeral: true,
			fetchReply: true
		});

		const collector = response.createMessageComponentCollector({
			time: 300_000 // 5 minutes
		});

		collector.on('collect', async (i) => {
			if (i.user.id !== interaction.user.id) {
				await i.reply({
					embeds: [this.errorEmbed('This interaction is not for you.')],
					ephemeral: true
				});
				return;
			}

			if (i.isButton()) {
				const customId = i.customId;

				if (customId === 'collection-mods:add') {
					collector.stop('action');
					await this.handleAddModerators(i, collection, interaction);
				} else if (customId === 'collection-mods:remove') {
					collector.stop('action');
					await this.handleRemoveModerators(i, collection, interaction);
				} else if (customId === 'collection-mods:done') {
					console.log(`[CMD] /collection-mods: DONE by userId=${interaction.user.id} collectionId=${collection.id}`);
					collector.stop('done');
					await i.deferUpdate();
					await interaction.editReply({
						embeds: [this.doneEmbed(collection)],
						components: []
					});
				}
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				console.log(`[CMD] /collection-mods timed out for userId=${interaction.user.id}`);
				await interaction.editReply({
					embeds: [this.timeoutEmbed()],
					components: []
				});
			}
		});
	}

	private async handleAddModerators(
		buttonInteraction: ButtonInteraction,
		collection: Collection,
		originalInteraction: Command.ChatInputCommandInteraction
	): Promise<void> {
		// dismiss ephemeral first
		await buttonInteraction.deferUpdate();
		await originalInteraction.editReply({
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

		// send public instruction msg
		const instructionEmbed = new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('Add Moderators')
			.setDescription(
				"**Press Start when you're ready to add moderators.**\n\n" +
					'After pressing Start, send messages containing:\n' +
					'• **User mentions**: @user1 @user2\n' +
					'• **Role mentions**: @Role1 @Role2\n' +
					'• **User/Role IDs**: `123456789012345678`\n\n' +
					'You can include multiple mentions/IDs per message.\n' +
					'Send **stop**, **done**, or any non-ID/mention text to finish.'
			)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		const startRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId('collection-mods:add:start').setLabel('Start').setStyle(ButtonStyle.Success).setEmoji('▶️'),
			new ButtonBuilder().setCustomId('collection-mods:add:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
		);

		const channel = buttonInteraction.channel as GuildTextBasedChannel;
		const instructionMessage = await channel.send({
			embeds: [instructionEmbed],
			components: [startRow]
		});

		// wait for button
		const buttonCollector = instructionMessage.createMessageComponentCollector({
			filter: (i: MessageComponentInteraction) => i.user.id === buttonInteraction.user.id && i.customId.startsWith('collection-mods:add:'),
			time: 60_000,
			max: 1
		});

		buttonCollector.on('collect', async (i: MessageComponentInteraction) => {
			if (i.customId === 'collection-mods:add:cancel') {
				console.log(`[CMD] /collection-mods: Add cancelled by userId=${originalInteraction.user.id}`);
				await i.deferUpdate();
				await instructionMessage.delete();
				await this.refreshModeratorsList(originalInteraction, collection);
				return;
			}

			// they pressed start
			await i.deferUpdate();
			await this.collectModeratorsToAdd(instructionMessage, collection, originalInteraction);
		});

		buttonCollector.on('end', async (_collected: unknown, reason: string) => {
			if (reason === 'time' && (_collected as Map<string, unknown>).size === 0) {
				console.log(`[CMD] /collection-mods: Add timed out waiting for start userId=${originalInteraction.user.id}`);
				await instructionMessage.delete().catch(() => {});
				await this.refreshModeratorsList(originalInteraction, collection);
			}
		});
	}

	private async collectModeratorsToAdd(
		instructionMessage: Message,
		collection: Collection,
		originalInteraction: Command.ChatInputCommandInteraction
	): Promise<void> {
		// show collecting state
		const collectingEmbed = new EmbedBuilder()
			.setColor(SUCCESS_COLOR)
			.setTitle('📝 Now Accepting Moderators')
			.setDescription(
				'**Start pinging/typing moderators now!**\n\n' +
					'Send messages with:\n' +
					'• User mentions: @user1 @user2\n' +
					'• Role mentions: @Role1 @Role2\n' +
					'• IDs: `123456789012345678`\n\n' +
					'Type **stop**, **done**, **cancel**, or any other text to finish.'
			)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		await instructionMessage.edit({
			embeds: [collectingEmbed],
			components: []
		});

		const addedMods: { type: 'user' | 'role'; value: string }[] = [];
		const skippedDuplicates: string[] = [];
		const existingMods = Moderator.listByCollection(collection.id);
		const existingSet = new Set(existingMods.map((m) => `${m.type}:${m.value}`));

		const channel = instructionMessage.channel as GuildTextBasedChannel;
		const messageCollector = channel.createMessageCollector({
			filter: (m: Message) => m.author.id === originalInteraction.user.id,
			time: 120_000 // 2 minutes
		});

		messageCollector.on('collect', async (message: Message) => {
			const content = message.content;

			// check stop
			const lowerContent = content.toLowerCase().trim();
			if (['stop', 'done', 'cancel', 'finish', 'end'].includes(lowerContent)) {
				messageCollector.stop('completed');
				return;
			}

			// grab user mentions
			const userMatches = [...content.matchAll(USER_MENTION_REGEX)];
			for (const match of userMatches) {
				const userId = match[1];
				const key = `user:${userId}`;
				if (existingSet.has(key)) {
					skippedDuplicates.push(`<@${userId}>`);
				} else if (!addedMods.some((m) => m.type === 'user' && m.value === userId)) {
					addedMods.push({ type: 'user', value: userId });
					existingSet.add(key);
				}
			}

			// grab role mentions
			const roleMatches = [...content.matchAll(ROLE_MENTION_REGEX)];
			for (const match of roleMatches) {
				const roleId = match[1];
				const key = `role:${roleId}`;
				if (existingSet.has(key)) {
					skippedDuplicates.push(`<@&${roleId}>`);
				} else if (!addedMods.some((m) => m.type === 'role' && m.value === roleId)) {
					addedMods.push({ type: 'role', value: roleId });
					existingSet.add(key);
				}
			}

			// raw ids (assume user)
			const mentionedIds = new Set([...userMatches.map((m) => m[1]), ...roleMatches.map((m) => m[1])]);
			const rawIdMatches = [...content.matchAll(SNOWFLAKE_REGEX)];
			for (const match of rawIdMatches) {
				const id = match[1];
				if (mentionedIds.has(id)) continue; // skip already handled

				// default user type for raw ids
				const key = `user:${id}`;
				if (existingSet.has(key)) {
					skippedDuplicates.push(`\`${id}\``);
				} else if (!addedMods.some((m) => m.type === 'user' && m.value === id)) {
					addedMods.push({ type: 'user', value: id });
					existingSet.add(key);
				}
			}

			// no patterns = stop
			if (userMatches.length === 0 && roleMatches.length === 0 && rawIdMatches.length === 0) {
				messageCollector.stop('completed');
				return;
			}

			// clean up their msg
			await message.delete().catch(() => {});
		});

		messageCollector.on('end', async () => {
			// save collected mods
			let savedCount = 0;
			const grantedModerators: Array<{ type: string; value: string }> = [];
			for (const mod of addedMods) {
				try {
					Moderator.grant({
						collectionId: collection.id,
						type: mod.type,
						value: mod.value,
						grantedBy: originalInteraction.user.id
					});
					savedCount++;
					grantedModerators.push({ type: mod.type, value: mod.value });
				} catch (error) {
					console.error(`[CMD] /collection-mods: Failed to grant moderator ${mod.type}:${mod.value}`, error);
				}
			}

			console.log(
				`[CMD] /collection-mods: Added ${savedCount} moderators by userId=${originalInteraction.user.id} collectionId=${collection.id}`
			);

			// audit log
			if (grantedModerators.length > 0) {
				logAction({
					collectionId: collection.id,
					action: 'moderator.add',
					performedBy: originalInteraction.user.id,
					details: {
						moderators: grantedModerators,
						count: grantedModerators.length
					}
				});
			}

			// build result
			let resultDescription = '';
			if (savedCount > 0) {
				const addedList = addedMods.map((m) => (m.type === 'role' ? `<@&${m.value}>` : `<@${m.value}>`)).join(', ');
				resultDescription += `**Added ${savedCount} moderator(s):**\n${addedList}\n\n`;
			} else {
				resultDescription += 'No new moderators were added.\n\n';
			}

			if (skippedDuplicates.length > 0) {
				resultDescription += `**Skipped (already moderators):**\n${skippedDuplicates.join(', ')}`;
			}

			const resultEmbed = new EmbedBuilder()
				.setColor(savedCount > 0 ? SUCCESS_COLOR : WARNING_COLOR)
				.setTitle('Add Moderators Complete')
				.setDescription(resultDescription)
				.setFooter({ text: FOOTER_CATEGORY })
				.setTimestamp();

			await instructionMessage.edit({
				embeds: [resultEmbed],
				components: []
			});

			// auto-delete
			setTimeout(() => {
				instructionMessage.delete().catch(() => {});
			}, 10_000);

			// refresh list
			await this.refreshModeratorsList(originalInteraction, collection);
		});
	}

	private async handleRemoveModerators(
		buttonInteraction: ButtonInteraction,
		collection: Collection,
		originalInteraction: Command.ChatInputCommandInteraction
	): Promise<void> {
		const moderators = Moderator.listByCollection(collection.id);

		if (moderators.length === 0) {
			await buttonInteraction.reply({
				embeds: [this.errorEmbed('There are no moderators to remove.')],
				ephemeral: true
			});
			await this.refreshModeratorsList(originalInteraction, collection);
			return;
		}

		// dismiss ephemeral
		await buttonInteraction.deferUpdate();
		await originalInteraction.editReply({
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

		// send public msg
		const instructionEmbed = new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('Remove Moderators')
			.setDescription(
				"**Press Start when you're ready to remove moderators.**\n\n" +
					'After pressing Start, send messages containing:\n' +
					'• **User mentions**: @user1 @user2\n' +
					'• **Role mentions**: @Role1 @Role2\n' +
					'• **User/Role IDs**: `123456789012345678`\n\n' +
					'You can include multiple mentions/IDs per message.\n' +
					'Send **stop**, **done**, or any non-ID/mention text to finish.'
			)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		const startRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId('collection-mods:remove:start').setLabel('Start').setStyle(ButtonStyle.Danger).setEmoji('▶️'),
			new ButtonBuilder().setCustomId('collection-mods:remove:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
		);

		const channel = buttonInteraction.channel as GuildTextBasedChannel;
		const instructionMessage = await channel.send({
			embeds: [instructionEmbed],
			components: [startRow]
		});

		// wait for button
		const buttonCollector = instructionMessage.createMessageComponentCollector({
			filter: (i: MessageComponentInteraction) => i.user.id === buttonInteraction.user.id && i.customId.startsWith('collection-mods:remove:'),
			time: 60_000,
			max: 1
		});

		buttonCollector.on('collect', async (i: MessageComponentInteraction) => {
			if (i.customId === 'collection-mods:remove:cancel') {
				console.log(`[CMD] /collection-mods: Remove cancelled by userId=${originalInteraction.user.id}`);
				await i.deferUpdate();
				await instructionMessage.delete();
				await this.refreshModeratorsList(originalInteraction, collection);
				return;
			}

			// they pressed start
			await i.deferUpdate();
			await this.collectModeratorsToRemove(instructionMessage, collection, originalInteraction);
		});

		buttonCollector.on('end', async (_collected: unknown, reason: string) => {
			if (reason === 'time' && (_collected as Map<string, unknown>).size === 0) {
				console.log(`[CMD] /collection-mods: Remove timed out waiting for start userId=${originalInteraction.user.id}`);
				await instructionMessage.delete().catch(() => {});
				await this.refreshModeratorsList(originalInteraction, collection);
			}
		});
	}

	private async collectModeratorsToRemove(
		instructionMessage: Message,
		collection: Collection,
		originalInteraction: Command.ChatInputCommandInteraction
	): Promise<void> {
		// show collecting state
		const collectingEmbed = new EmbedBuilder()
			.setColor(ERROR_COLOR)
			.setTitle('📝 Now Removing Moderators')
			.setDescription(
				'**Start pinging/typing moderators to remove now!**\n\n' +
					'Send messages with:\n' +
					'• User mentions: @user1 @user2\n' +
					'• Role mentions: @Role1 @Role2\n' +
					'• IDs: `123456789012345678`\n\n' +
					'Type **stop**, **done**, **cancel**, or any other text to finish.'
			)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		await instructionMessage.edit({
			embeds: [collectingEmbed],
			components: []
		});

		const removedMods: { type: 'user' | 'role'; value: string }[] = [];
		const notFoundMods: string[] = [];
		const existingMods = Moderator.listByCollection(collection.id);
		const existingMap = new Map(existingMods.map((m) => [`${m.type}:${m.value}`, m]));

		const channel = instructionMessage.channel as GuildTextBasedChannel;
		const messageCollector = channel.createMessageCollector({
			filter: (m: Message) => m.author.id === originalInteraction.user.id,
			time: 120_000 // 2 minutes
		});

		messageCollector.on('collect', async (message: Message) => {
			const content = message.content;

			// check stop
			const lowerContent = content.toLowerCase().trim();
			if (['stop', 'done', 'cancel', 'finish', 'end'].includes(lowerContent)) {
				messageCollector.stop('completed');
				return;
			}

			// user mentions
			const userMatches = [...content.matchAll(USER_MENTION_REGEX)];
			for (const match of userMatches) {
				const userId = match[1];
				const key = `user:${userId}`;
				const mod = existingMap.get(key);
				if (mod) {
					if (!removedMods.some((m) => m.type === 'user' && m.value === userId)) {
						removedMods.push({ type: 'user', value: userId });
					}
				} else {
					notFoundMods.push(`<@${userId}>`);
				}
			}

			// role mentions
			const roleMatches = [...content.matchAll(ROLE_MENTION_REGEX)];
			for (const match of roleMatches) {
				const roleId = match[1];
				const key = `role:${roleId}`;
				const mod = existingMap.get(key);
				if (mod) {
					if (!removedMods.some((m) => m.type === 'role' && m.value === roleId)) {
						removedMods.push({ type: 'role', value: roleId });
					}
				} else {
					notFoundMods.push(`<@&${roleId}>`);
				}
			}

			// raw ids
			const mentionedIds = new Set([...userMatches.map((m) => m[1]), ...roleMatches.map((m) => m[1])]);
			const rawIdMatches = [...content.matchAll(SNOWFLAKE_REGEX)];
			for (const match of rawIdMatches) {
				const id = match[1];
				if (mentionedIds.has(id)) continue;

				// try user then role
				const userKey = `user:${id}`;
				const roleKey = `role:${id}`;
				if (existingMap.has(userKey)) {
					if (!removedMods.some((m) => m.type === 'user' && m.value === id)) {
						removedMods.push({ type: 'user', value: id });
					}
				} else if (existingMap.has(roleKey)) {
					if (!removedMods.some((m) => m.type === 'role' && m.value === id)) {
						removedMods.push({ type: 'role', value: id });
					}
				} else {
					notFoundMods.push(`\`${id}\``);
				}
			}

			// no patterns = stop
			if (userMatches.length === 0 && roleMatches.length === 0 && rawIdMatches.length === 0) {
				messageCollector.stop('completed');
				return;
			}

			// clean up msg
			await message.delete().catch(() => {});
		});

		messageCollector.on('end', async () => {
			// remove all collected
			let removedCount = 0;
			const revokedModerators: Array<{ type: string; value: string }> = [];
			for (const mod of removedMods) {
				try {
					const existing = existingMap.get(`${mod.type}:${mod.value}`);
					if (existing) {
						existing.remove();
						removedCount++;
						revokedModerators.push({ type: mod.type, value: mod.value });
					}
				} catch (error) {
					console.error(`[CMD] /collection-mods: Failed to remove moderator ${mod.type}:${mod.value}`, error);
				}
			}

			console.log(
				`[CMD] /collection-mods: Removed ${removedCount} moderators by userId=${originalInteraction.user.id} collectionId=${collection.id}`
			);

			// audit log
			if (revokedModerators.length > 0) {
				logAction({
					collectionId: collection.id,
					action: 'moderator.remove',
					performedBy: originalInteraction.user.id,
					details: {
						moderators: revokedModerators,
						count: revokedModerators.length
					}
				});
			}

			// build result
			let resultDescription = '';
			if (removedCount > 0) {
				const removedList = removedMods.map((m) => (m.type === 'role' ? `<@&${m.value}>` : `<@${m.value}>`)).join(', ');
				resultDescription += `**Removed ${removedCount} moderator(s):**\n${removedList}\n\n`;
			} else {
				resultDescription += 'No moderators were removed.\n\n';
			}

			if (notFoundMods.length > 0) {
				resultDescription += `**Not found (not moderators):**\n${notFoundMods.join(', ')}`;
			}

			const resultEmbed = new EmbedBuilder()
				.setColor(removedCount > 0 ? SUCCESS_COLOR : WARNING_COLOR)
				.setTitle('Remove Moderators Complete')
				.setDescription(resultDescription)
				.setFooter({ text: FOOTER_CATEGORY })
				.setTimestamp();

			await instructionMessage.edit({
				embeds: [resultEmbed],
				components: []
			});

			// auto-delete
			setTimeout(() => {
				instructionMessage.delete().catch(() => {});
			}, 10_000);

			// refresh list
			await this.refreshModeratorsList(originalInteraction, collection);
		});
	}

	private async refreshModeratorsList(originalInteraction: Command.ChatInputCommandInteraction, collection: Collection): Promise<void> {
		const moderators = Moderator.listByCollection(collection.id);
		const embed = this.buildModeratorsListEmbed(collection, moderators);
		const components = this.buildMainButtons();

		const response = await originalInteraction.editReply({
			embeds: [embed],
			components
		});

		const collector = response.createMessageComponentCollector({
			time: 300_000 // 5 minutes
		});

		collector.on('collect', async (i) => {
			if (i.user.id !== originalInteraction.user.id) {
				await i.reply({
					embeds: [this.errorEmbed('This interaction is not for you.')],
					ephemeral: true
				});
				return;
			}

			if (i.isButton()) {
				const customId = i.customId;

				if (customId === 'collection-mods:add') {
					collector.stop('action');
					await this.handleAddModerators(i, collection, originalInteraction);
				} else if (customId === 'collection-mods:remove') {
					collector.stop('action');
					await this.handleRemoveModerators(i, collection, originalInteraction);
				} else if (customId === 'collection-mods:done') {
					console.log(`[CMD] /collection-mods: DONE by userId=${originalInteraction.user.id} collectionId=${collection.id}`);
					collector.stop('done');
					await i.deferUpdate();
					await originalInteraction.editReply({
						embeds: [this.doneEmbed(collection)],
						components: []
					});
				}
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				console.log(`[CMD] /collection-mods timed out for userId=${originalInteraction.user.id}`);
				await originalInteraction.editReply({
					embeds: [this.timeoutEmbed()],
					components: []
				});
			}
		});
	}

	private buildModeratorsListEmbed(collection: Collection, moderators: Moderator[]): EmbedBuilder {
		const embed = new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('Collection Moderators')
			.setDescription(`Manage moderators for **${collection.name}**`)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		if (moderators.length === 0) {
			embed.addFields({
				name: 'Moderators',
				value: '*No moderators assigned yet.*',
				inline: false
			});
		} else {
			const users = moderators.filter((m) => m.type === 'user');
			const roles = moderators.filter((m) => m.type === 'role');

			if (users.length > 0) {
				const userList = users.map((m) => `• <@${m.value}> (\`${m.value}\`)`).join('\n');
				embed.addFields({
					name: `Users (${users.length})`,
					value: userList.length > 1024 ? userList.substring(0, 1020) + '...' : userList,
					inline: false
				});
			}

			if (roles.length > 0) {
				const roleList = roles.map((m) => `• <@&${m.value}> (\`${m.value}\`)`).join('\n');
				embed.addFields({
					name: `Roles (${roles.length})`,
					value: roleList.length > 1024 ? roleList.substring(0, 1020) + '...' : roleList,
					inline: false
				});
			}

			embed.addFields({
				name: 'Total',
				value: `\`${moderators.length}\` moderator(s)`,
				inline: true
			});
		}

		embed.addFields({
			name: 'Collection ID',
			value: `\`${collection.id}\``,
			inline: true
		});

		return embed;
	}

	private buildMainButtons(): ActionRowBuilder<ButtonBuilder>[] {
		return [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId('collection-mods:add').setLabel('Add Moderators').setStyle(ButtonStyle.Success).setEmoji('➕'),
				new ButtonBuilder().setCustomId('collection-mods:remove').setLabel('Remove Moderators').setStyle(ButtonStyle.Danger).setEmoji('➖'),
				new ButtonBuilder().setCustomId('collection-mods:done').setLabel('Done').setStyle(ButtonStyle.Secondary).setEmoji('✅')
			)
		];
	}

	private doneEmbed(collection: Collection): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(SUCCESS_COLOR)
			.setTitle('Moderators Updated')
			.setDescription(`Moderator management for **${collection.name}** is complete.`)
			.addFields({
				name: 'Collection ID',
				value: `\`${collection.id}\``,
				inline: true
			})
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}

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
}

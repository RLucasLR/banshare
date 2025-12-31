import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	InteractionContextType,
	ModalBuilder,
	PermissionFlagsBits,
	TextInputBuilder,
	TextInputStyle,
	type ButtonInteraction,
	type ModalSubmitInteraction
} from 'discord.js';
import { Collection, RecordNotFoundError, type OnServerRemovePolicy } from '../database/models';
import { logAction } from '../lib/utils';

const FOOTER_CATEGORY = 'BanShare • Collections';
const EMBED_COLOR = 0x5865f2; // blurple
const ERROR_COLOR = 0xed4245; // red
const SUCCESS_COLOR = 0x57f287; // green
const WARNING_COLOR = 0xfee75c; // yellow

@ApplyOptions<Command.Options>({
	description: 'Edit an existing collection for this server'
})
export class CollectionEditCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: 'collection-edit',
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

		console.log(`[CMD] /collection-edit initiated by userId=${interaction.user.id} in guildId=${interaction.guildId}`);

		// check perms
		const member = interaction.member;
		const isGuildOwner = interaction.guild?.ownerId === interaction.user.id;
		const hasAdminPermission =
			member && 'permissions' in member && typeof member.permissions !== 'string' && member.permissions.has(PermissionFlagsBits.Administrator);

		if (!isGuildOwner && !hasAdminPermission) {
			await interaction.reply({
				embeds: [this.errorEmbed('You must be the **server owner** or have **Administrator** permission to edit a collection.')],
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
							'This server does not own a collection. This command can only be used in the **owner server** of a collection. Use `/collection-create` to create one, or run this command in the server that owns your collection.'
						)
					],
					ephemeral: true
				});
				return;
			}
			throw error;
		}

		const embed = this.buildEditEmbed(collection);
		const components = this.buildButtons();

		const response = await interaction.reply({
			embeds: [embed],
			components,
			ephemeral: true,
			fetchReply: true
		});

		const collector = response.createMessageComponentCollector({
			time: 300_000 // 5 min
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
				await this.handleButton(i, collection, interaction);
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				console.log(`[CMD] /collection-edit timed out for userId=${interaction.user.id}`);
				await interaction.editReply({
					embeds: [this.timeoutEmbed()],
					components: []
				});
			}
		});
	}

	private async handleButton(
		buttonInteraction: ButtonInteraction,
		collection: Collection,
		originalInteraction: Command.ChatInputCommandInteraction
	) {
		const customId = buttonInteraction.customId;

		// text modals
		if (customId === 'collection-edit:edit-name') {
			await this.handleEditName(buttonInteraction, collection, originalInteraction);
		} else if (customId === 'collection-edit:edit-description') {
			await this.handleEditDescription(buttonInteraction, collection, originalInteraction);
		} else if (customId === 'collection-edit:edit-max-servers') {
			await this.handleEditMaxServers(buttonInteraction, collection, originalInteraction);
		}
		// toggles
		else if (customId === 'collection-edit:toggle-logging') {
			await this.handleToggleSetting(
				buttonInteraction,
				collection,
				originalInteraction,
				'loggingEnabledAtCollectionLevel',
				'Collection-Level Logging',
				'When enabled, logs are posted at the collection level. When disabled, logging behavior depends on individual server settings.'
			);
		} else if (customId === 'collection-edit:toggle-dm-on-ban') {
			await this.handleToggleSetting(
				buttonInteraction,
				collection,
				originalInteraction,
				'dmOnBan',
				'DM on Ban',
				'When enabled, users will receive a DM when they are banned through this collection.'
			);
		} else if (customId === 'collection-edit:toggle-analytics') {
			await this.handleToggleSetting(
				buttonInteraction,
				collection,
				originalInteraction,
				'analyticsEnabled',
				'Analytics',
				'When enabled, analytics data will be collected for this collection.'
			);
		}
		// policy selector
		else if (customId === 'collection-edit:edit-on-server-remove') {
			await this.handleEditOnServerRemove(buttonInteraction, collection, originalInteraction);
		}
		// done
		else if (customId === 'collection-edit:done') {
			console.log(`[CMD] /collection-edit: DONE by userId=${originalInteraction.user.id} collectionId=${collection.id}`);
			await buttonInteraction.deferUpdate();
			await originalInteraction.editReply({
				embeds: [this.doneEmbed(collection)],
				components: []
			});
		}
	}

	private async handleEditName(
		buttonInteraction: ButtonInteraction,
		collection: Collection,
		originalInteraction: Command.ChatInputCommandInteraction
	) {
		const nameInput = new TextInputBuilder()
			.setCustomId('name')
			.setLabel('Collection Name')
			.setStyle(TextInputStyle.Short)
			.setPlaceholder('Enter a name for this collection')
			.setMinLength(1)
			.setMaxLength(100)
			.setRequired(true);

		// prefill
		if (collection.name) {
			nameInput.setValue(collection.name);
		}

		const modal = new ModalBuilder()
			.setCustomId('collection-edit:modal-name')
			.setTitle('Edit Collection Name')
			.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput));

		await buttonInteraction.showModal(modal);

		const modalSubmit = await this.awaitModal(buttonInteraction, 'collection-edit:modal-name');
		if (!modalSubmit) return;

		const newName = modalSubmit.fields.getTextInputValue('name');
		const oldName = collection.name;
		collection.name = newName;
		collection.save();

		console.log(`[CMD] /collection-edit: userId=${originalInteraction.user.id} set name="${newName}" collectionId=${collection.id}`);

		// audit
		logAction({
			collectionId: collection.id,
			action: 'setting.update',
			performedBy: originalInteraction.user.id,
			details: {
				setting: 'name',
				oldValue: oldName,
				newValue: newName
			}
		});

		await modalSubmit.deferUpdate();
		await this.updateEditEmbed(originalInteraction, collection);
	}

	private async handleEditDescription(
		buttonInteraction: ButtonInteraction,
		collection: Collection,
		originalInteraction: Command.ChatInputCommandInteraction
	) {
		const descriptionInput = new TextInputBuilder()
			.setCustomId('description')
			.setLabel('Description (Optional)')
			.setStyle(TextInputStyle.Paragraph)
			.setPlaceholder('Enter a description for this collection')
			.setMaxLength(500)
			.setRequired(false);

		// prefill
		if (collection.description) {
			descriptionInput.setValue(collection.description);
		}

		const modal = new ModalBuilder()
			.setCustomId('collection-edit:modal-description')
			.setTitle('Edit Collection Description')
			.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput));

		await buttonInteraction.showModal(modal);

		const modalSubmit = await this.awaitModal(buttonInteraction, 'collection-edit:modal-description');
		if (!modalSubmit) return;

		const descValue = modalSubmit.fields.getTextInputValue('description');
		const oldDescription = collection.description;
		collection.description = descValue.trim() || null;
		collection.save();

		console.log(
			`[CMD] /collection-edit: userId=${originalInteraction.user.id} set description=${collection.description ? `"${collection.description.substring(0, 50)}..."` : 'null'} collectionId=${collection.id}`
		);

		// audit
		logAction({
			collectionId: collection.id,
			action: 'setting.update',
			performedBy: originalInteraction.user.id,
			details: {
				setting: 'description',
				oldValue: oldDescription,
				newValue: collection.description
			}
		});

		await modalSubmit.deferUpdate();
		await this.updateEditEmbed(originalInteraction, collection);
	}

	private async handleEditMaxServers(
		buttonInteraction: ButtonInteraction,
		collection: Collection,
		originalInteraction: Command.ChatInputCommandInteraction
	) {
		const maxServersInput = new TextInputBuilder()
			.setCustomId('max-servers')
			.setLabel('Max Linked Servers')
			.setStyle(TextInputStyle.Short)
			.setPlaceholder('Enter a positive number (e.g., 30)')
			.setMinLength(1)
			.setMaxLength(10)
			.setRequired(true)
			.setValue(String(collection.maxLinkedServers));

		const modal = new ModalBuilder()
			.setCustomId('collection-edit:modal-max-servers')
			.setTitle('Edit Max Linked Servers')
			.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(maxServersInput));

		await buttonInteraction.showModal(modal);

		const modalSubmit = await this.awaitModal(buttonInteraction, 'collection-edit:modal-max-servers');
		if (!modalSubmit) return;

		const rawValue = modalSubmit.fields.getTextInputValue('max-servers');
		const parsed = parseInt(rawValue, 10);

		if (!Number.isFinite(parsed) || parsed <= 0) {
			await modalSubmit.reply({
				embeds: [this.errorEmbed('Max linked servers must be a positive number.')],
				ephemeral: true
			});
			return;
		}

		const oldMaxServers = collection.maxLinkedServers;
		collection.maxLinkedServers = parsed;
		collection.save();

		console.log(`[CMD] /collection-edit: userId=${originalInteraction.user.id} set maxLinkedServers=${parsed} collectionId=${collection.id}`);

		// audit
		logAction({
			collectionId: collection.id,
			action: 'setting.update',
			performedBy: originalInteraction.user.id,
			details: {
				setting: 'maxLinkedServers',
				oldValue: oldMaxServers,
				newValue: parsed
			}
		});

		await modalSubmit.deferUpdate();
		await this.updateEditEmbed(originalInteraction, collection);
	}

	private async handleToggleSetting(
		buttonInteraction: ButtonInteraction,
		collection: Collection,
		originalInteraction: Command.ChatInputCommandInteraction,
		field: 'loggingEnabledAtCollectionLevel' | 'dmOnBan' | 'analyticsEnabled',
		displayName: string,
		description: string
	) {
		const currentValue = collection[field];
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
					.setCustomId(`collection-edit:toggle-${field}:enable`)
					.setLabel('Enable')
					.setStyle(pending ? ButtonStyle.Success : ButtonStyle.Secondary),
				new ButtonBuilder()
					.setCustomId(`collection-edit:toggle-${field}:disable`)
					.setLabel('Disable')
					.setStyle(!pending ? ButtonStyle.Danger : ButtonStyle.Secondary)
			),
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId(`collection-edit:toggle-${field}:save`).setLabel('Save').setStyle(ButtonStyle.Success).setEmoji('💾'),
				new ButtonBuilder().setCustomId(`collection-edit:toggle-${field}:cancel`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
			)
		];

		const reply = await buttonInteraction.reply({
			embeds: [buildToggleEmbed(pendingValue)],
			components: buildToggleButtons(pendingValue),
			ephemeral: true,
			fetchReply: true
		});

		const collector = reply.createMessageComponentCollector({
			filter: (i) => i.user.id === buttonInteraction.user.id && i.customId.startsWith(`collection-edit:toggle-${field}:`),
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
				collection[field] = pendingValue;
				collection.save();
				console.log(
					`[CMD] /collection-edit: userId=${originalInteraction.user.id} set ${field}=${pendingValue} collectionId=${collection.id}`
				);

				// audit
				logAction({
					collectionId: collection.id,
					action: 'setting.update',
					performedBy: originalInteraction.user.id,
					details: {
						setting: field,
						oldValue: currentValue,
						newValue: pendingValue
					}
				});

				collector.stop('saved');
				await i.deferUpdate();
				await buttonInteraction.deleteReply();
				await this.updateEditEmbed(originalInteraction, collection);
			} else if (i.customId.endsWith(':cancel')) {
				console.log(`[CMD] /collection-edit: userId=${originalInteraction.user.id} cancelled toggle ${field}`);
				collector.stop('cancelled');
				await i.deferUpdate();
				await buttonInteraction.deleteReply();
			}
		});
	}

	private async handleEditOnServerRemove(
		buttonInteraction: ButtonInteraction,
		collection: Collection,
		originalInteraction: Command.ChatInputCommandInteraction
	) {
		const currentValue = collection.onServerRemove;
		let pendingValue: OnServerRemovePolicy = currentValue;

		const buildPolicyEmbed = (pending: OnServerRemovePolicy) =>
			new EmbedBuilder()
				.setColor(WARNING_COLOR)
				.setTitle('On Server Remove Policy')
				.setDescription(
					'Choose what happens to bans when a server leaves the collection:\n\n' +
						'• **Retain**: Bans remain in place on the server\n' +
						'• **Lift**: Bans are automatically lifted when the server leaves\n' +
						'• **Archive**: Bans are archived for record-keeping'
				)
				.addFields(
					{
						name: 'Current Value',
						value: `\`${currentValue}\``,
						inline: true
					},
					{
						name: 'New Value',
						value: `\`${pending}\``,
						inline: true
					}
				)
				.setFooter({ text: FOOTER_CATEGORY })
				.setTimestamp();

		const buildPolicyButtons = (pending: OnServerRemovePolicy) => [
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId('collection-edit:policy:retain')
					.setLabel('Retain')
					.setStyle(pending === 'retain' ? ButtonStyle.Success : ButtonStyle.Secondary),
				new ButtonBuilder()
					.setCustomId('collection-edit:policy:lift')
					.setLabel('Lift')
					.setStyle(pending === 'lift' ? ButtonStyle.Success : ButtonStyle.Secondary),
				new ButtonBuilder()
					.setCustomId('collection-edit:policy:archive')
					.setLabel('Archive')
					.setStyle(pending === 'archive' ? ButtonStyle.Success : ButtonStyle.Secondary)
			),
			new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder().setCustomId('collection-edit:policy:save').setLabel('Save').setStyle(ButtonStyle.Success).setEmoji('💾'),
				new ButtonBuilder().setCustomId('collection-edit:policy:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
			)
		];

		const reply = await buttonInteraction.reply({
			embeds: [buildPolicyEmbed(pendingValue)],
			components: buildPolicyButtons(pendingValue),
			ephemeral: true,
			fetchReply: true
		});

		const collector = reply.createMessageComponentCollector({
			filter: (i) => i.user.id === buttonInteraction.user.id && i.customId.startsWith('collection-edit:policy:'),
			time: 60_000
		});

		collector.on('collect', async (i) => {
			if (!i.isButton()) return;

			const action = i.customId.split(':')[2];

			if (action === 'retain' || action === 'lift' || action === 'archive') {
				pendingValue = action;
				await i.update({
					embeds: [buildPolicyEmbed(pendingValue)],
					components: buildPolicyButtons(pendingValue)
				});
			} else if (action === 'save') {
				collection.onServerRemove = pendingValue;
				collection.save();
				console.log(
					`[CMD] /collection-edit: userId=${originalInteraction.user.id} set onServerRemove=${pendingValue} collectionId=${collection.id}`
				);
				collector.stop('saved');
				await i.deferUpdate();
				await buttonInteraction.deleteReply();
				await this.updateEditEmbed(originalInteraction, collection);
			} else if (action === 'cancel') {
				console.log(`[CMD] /collection-edit: userId=${originalInteraction.user.id} cancelled onServerRemove change`);
				collector.stop('cancelled');
				await i.deferUpdate();
				await buttonInteraction.deleteReply();
			}
		});
	}

	private async awaitModal(buttonInteraction: ButtonInteraction, customId: string): Promise<ModalSubmitInteraction | null> {
		try {
			return await buttonInteraction.awaitModalSubmit({
				filter: (i) => i.customId === customId && i.user.id === buttonInteraction.user.id,
				time: 120_000 // 2 min for modal
			});
		} catch {
			return null;
		}
	}

	private async updateEditEmbed(interaction: Command.ChatInputCommandInteraction, collection: Collection) {
		collection.reload(); // refresh
		await interaction.editReply({
			embeds: [this.buildEditEmbed(collection)],
			components: this.buildButtons()
		});
	}

	private buildEditEmbed(collection: Collection): EmbedBuilder {
		const createdAtUnix = Math.floor(new Date(collection.createdAt).getTime() / 1000);

		return new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('Edit Collection')
			.setDescription('Use the buttons below to edit your collection settings.')
			.addFields(
				{
					name: 'Collection ID',
					value: `\`${collection.id}\``,
					inline: true
				},
				{
					name: 'Name',
					value: `\`${collection.name}\``,
					inline: true
				},
				{
					name: 'Description',
					value: collection.description ?? '*No description*',
					inline: false
				},
				{
					name: 'Max Linked Servers',
					value: `\`${collection.maxLinkedServers}\``,
					inline: true
				},
				{
					name: 'Logging Enabled',
					value: collection.loggingEnabledAtCollectionLevel ? '`Enabled`' : '`Disabled`',
					inline: true
				},
				{
					name: 'DM on Ban',
					value: collection.dmOnBan ? '`Enabled`' : '`Disabled`',
					inline: true
				},
				{
					name: 'Analytics',
					value: collection.analyticsEnabled ? '`Enabled`' : '`Disabled`',
					inline: true
				},
				{
					name: 'On Server Remove',
					value: `\`${collection.onServerRemove}\``,
					inline: true
				},
				{
					name: 'Created',
					value: `<t:${createdAtUnix}:F> (<t:${createdAtUnix}:R>)`,
					inline: false
				}
			)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}

	private buildButtons(): ActionRowBuilder<ButtonBuilder>[] {
		// row 1 - text inputs
		const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId('collection-edit:edit-name').setLabel('Edit Name').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
			new ButtonBuilder()
				.setCustomId('collection-edit:edit-description')
				.setLabel('Edit Description')
				.setStyle(ButtonStyle.Primary)
				.setEmoji('📝'),
			new ButtonBuilder().setCustomId('collection-edit:edit-max-servers').setLabel('Max Servers').setStyle(ButtonStyle.Primary).setEmoji('🔢')
		);

		// row 2 - toggles
		const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId('collection-edit:toggle-logging').setLabel('Logging').setStyle(ButtonStyle.Secondary).setEmoji('📋'),
			new ButtonBuilder().setCustomId('collection-edit:toggle-dm-on-ban').setLabel('DM on Ban').setStyle(ButtonStyle.Secondary).setEmoji('✉️'),
			new ButtonBuilder().setCustomId('collection-edit:toggle-analytics').setLabel('Analytics').setStyle(ButtonStyle.Secondary).setEmoji('📊')
		);

		// row 3 - policy + done
		const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId('collection-edit:edit-on-server-remove')
				.setLabel('On Server Remove')
				.setStyle(ButtonStyle.Secondary)
				.setEmoji('🚪'),
			new ButtonBuilder().setCustomId('collection-edit:done').setLabel('Done').setStyle(ButtonStyle.Success).setEmoji('✅')
		);

		return [row1, row2, row3];
	}

	private doneEmbed(collection: Collection): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(SUCCESS_COLOR)
			.setTitle('Collection Updated')
			.setDescription('Your collection settings have been saved.')
			.addFields(
				{
					name: 'Collection ID',
					value: `\`${collection.id}\``,
					inline: true
				},
				{
					name: 'Name',
					value: `\`${collection.name}\``,
					inline: true
				}
			)
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

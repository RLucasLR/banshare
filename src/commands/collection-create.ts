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
import { Collection, RecordNotFoundError, Server } from '../database/models';
import { logAction } from '../lib/utils';

const FOOTER_CATEGORY = 'BanShare • Collections';
const EMBED_COLOR = 0x5865f2; // blurple
const ERROR_COLOR = 0xed4245; // red
const SUCCESS_COLOR = 0x57f287; // green

interface CollectionDraft {
	name: string | null;
	description: string | null;
}

@ApplyOptions<Command.Options>({
	description: 'Create a new collection for this server'
})
export class CollectionCreateCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: 'collection-create',
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

		console.log(`[CMD] /collection-create initiated by userId=${interaction.user.id} in guildId=${interaction.guildId}`);

		// check perms
		const member = interaction.member;
		const isGuildOwner = interaction.guild?.ownerId === interaction.user.id;
		const hasAdminPermission =
			member && 'permissions' in member && typeof member.permissions !== 'string' && member.permissions.has(PermissionFlagsBits.Administrator);

		if (!isGuildOwner && !hasAdminPermission) {
			await interaction.reply({
				embeds: [this.errorEmbed('You must be the **server owner** or have **Administrator** permission to create a collection.')],
				ephemeral: true
			});
			return;
		}

		// check if already owns a collection
		try {
			const existingCollection = Collection.getByMainGuildId(interaction.guildId);
			await interaction.reply({
				embeds: [
					this.errorEmbed(
						`This server already owns a collection: \`${existingCollection.name}\` (ID: \`${existingCollection.id}\`). Use \`/collection-edit\` to modify it.`
					)
				],
				ephemeral: true
			});
			return;
		} catch (error) {
			if (!(error instanceof RecordNotFoundError)) throw error;
			// no collection, continue
		}

		// check if already in another collection
		try {
			const existingServer = Server.getByGuildId(interaction.guildId);
			await interaction.reply({
				embeds: [
					this.errorEmbed(
						`This server is already a member of a collection (ID: \`${existingServer.collectionId}\`). Leave that collection first before creating a new one.`
					)
				],
				ephemeral: true
			});
			return;
		} catch (error) {
			if (!(error instanceof RecordNotFoundError)) throw error;
			// not in collection, continue
		}

		const draft: CollectionDraft = {
			name: null,
			description: null
		};

		const embed = this.buildDraftEmbed(draft);
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
				await this.handleButton(i, draft, interaction);
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				console.log(`[CMD] /collection-create timed out for userId=${interaction.user.id}`);
				await interaction.editReply({
					embeds: [this.timeoutEmbed()],
					components: []
				});
			}
		});
	}

	private async handleButton(
		buttonInteraction: ButtonInteraction,
		draft: CollectionDraft,
		originalInteraction: Command.ChatInputCommandInteraction
	) {
		const customId = buttonInteraction.customId;

		if (customId === 'collection-create:edit-name') {
			const nameInput = new TextInputBuilder()
				.setCustomId('name')
				.setLabel('Collection Name')
				.setStyle(TextInputStyle.Short)
				.setPlaceholder('Enter a name for this collection')
				.setMinLength(1)
				.setMaxLength(100)
				.setRequired(true);

			// prefill if we have a value
			if (draft.name) {
				nameInput.setValue(draft.name);
			}

			const modal = new ModalBuilder()
				.setCustomId('collection-create:modal-name')
				.setTitle('Set Collection Name')
				.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput));

			await buttonInteraction.showModal(modal);

			const modalSubmit = await this.awaitModal(buttonInteraction, 'collection-create:modal-name');
			if (!modalSubmit) return;

			draft.name = modalSubmit.fields.getTextInputValue('name');
			console.log(`[CMD] /collection-create: userId=${originalInteraction.user.id} set name="${draft.name}"`);
			await modalSubmit.deferUpdate();
			await this.updateDraftEmbed(originalInteraction, draft);
		} else if (customId === 'collection-create:edit-description') {
			const descriptionInput = new TextInputBuilder()
				.setCustomId('description')
				.setLabel('Description (Optional)')
				.setStyle(TextInputStyle.Paragraph)
				.setPlaceholder('Enter a description for this collection')
				.setMaxLength(500)
				.setRequired(false);

			// prefill
			if (draft.description) {
				descriptionInput.setValue(draft.description);
			}

			const modal = new ModalBuilder()
				.setCustomId('collection-create:modal-description')
				.setTitle('Set Collection Description')
				.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput));

			await buttonInteraction.showModal(modal);

			const modalSubmit = await this.awaitModal(buttonInteraction, 'collection-create:modal-description');
			if (!modalSubmit) return;

			const descValue = modalSubmit.fields.getTextInputValue('description');
			draft.description = descValue.trim() || null;
			console.log(
				`[CMD] /collection-create: userId=${originalInteraction.user.id} set description=${draft.description ? `"${draft.description.substring(0, 50)}..."` : 'null'}`
			);
			await modalSubmit.deferUpdate();
			await this.updateDraftEmbed(originalInteraction, draft);
		} else if (customId === 'collection-create:save') {
			if (!draft.name) {
				console.log(`[CMD] /collection-create: userId=${originalInteraction.user.id} attempted save without name`);
				await buttonInteraction.reply({
					embeds: [this.errorEmbed('You must set a collection name before saving.')],
					ephemeral: true
				});
				return;
			}

			try {
				const collection = Collection.create({
					mainGuildId: originalInteraction.guildId!,
					name: draft.name,
					description: draft.description,
					createdBy: originalInteraction.user.id
				});

				console.log(`[CMD] /collection-create: SAVED successfully by userId=${originalInteraction.user.id} collectionId=${collection.id}`);

				// audit log
				logAction({
					collectionId: collection.id,
					action: 'collection.create',
					performedBy: originalInteraction.user.id,
					details: {
						name: collection.name,
						description: collection.description,
						mainGuildId: collection.mainGuildId
					}
				});

				await buttonInteraction.deferUpdate();
				await originalInteraction.editReply({
					embeds: [this.successEmbed(collection)],
					components: []
				});
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
				console.log(`[CMD] /collection-create: FAILED to save for userId=${originalInteraction.user.id} error=${errorMessage}`);
				await buttonInteraction.reply({
					embeds: [this.errorEmbed('Failed to create collection. Please try again.')],
					ephemeral: true
				});
			}
		} else if (customId === 'collection-create:cancel') {
			console.log(`[CMD] /collection-create: CANCELLED by userId=${originalInteraction.user.id}`);
			await buttonInteraction.deferUpdate();
			await originalInteraction.editReply({
				embeds: [this.cancelledEmbed()],
				components: []
			});
		}
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

	private async updateDraftEmbed(interaction: Command.ChatInputCommandInteraction, draft: CollectionDraft) {
		await interaction.editReply({
			embeds: [this.buildDraftEmbed(draft)],
			components: this.buildButtons()
		});
	}

	private buildDraftEmbed(draft: CollectionDraft): EmbedBuilder {
		const embed = new EmbedBuilder()
			.setColor(EMBED_COLOR)
			.setTitle('Create Collection')
			.setDescription('Configure your new collection using the buttons below, then click **Save** to create it.')
			.addFields(
				{
					name: 'Name',
					value: draft.name ? `\`${draft.name}\`` : '*Not set*',
					inline: true
				},
				{
					name: 'Description',
					value: draft.description ? draft.description : '*Not set*',
					inline: true
				}
			)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();

		return embed;
	}

	private buildButtons(): ActionRowBuilder<ButtonBuilder>[] {
		const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId('collection-create:edit-name').setLabel('Edit Name').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
			new ButtonBuilder()
				.setCustomId('collection-create:edit-description')
				.setLabel('Edit Description')
				.setStyle(ButtonStyle.Primary)
				.setEmoji('📝')
		);

		const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId('collection-create:save').setLabel('Save').setStyle(ButtonStyle.Success).setEmoji('💾'),
			new ButtonBuilder().setCustomId('collection-create:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('✖️')
		);

		return [row1, row2];
	}

	private successEmbed(collection: Collection): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(SUCCESS_COLOR)
			.setTitle('Collection Created')
			.setDescription('Your collection has been successfully created.')
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
					name: 'Created',
					value: `<t:${Math.floor(new Date(collection.createdAt).getTime() / 1000)}:F>`,
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

	private cancelledEmbed(): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(ERROR_COLOR)
			.setTitle('Cancelled')
			.setDescription('Collection creation was cancelled.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}
}

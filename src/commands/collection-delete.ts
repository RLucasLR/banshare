import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	InteractionContextType,
	PermissionFlagsBits,
	type ButtonInteraction
} from 'discord.js';
import { Collection, RecordNotFoundError, Server } from '../database/models';
import { logAction } from '../lib/utils';

const FOOTER_CATEGORY = 'BanShare • Collections';
const ERROR_COLOR = 0xed4245; // red
const SUCCESS_COLOR = 0x57f287; // green
const WARNING_COLOR = 0xfee75c; // yellow

@ApplyOptions<Command.Options>({
	description: 'Delete your collection permanently'
})
export class CollectionDeleteCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand({
			name: 'collection-delete',
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

		console.log(`[CMD] /collection-delete initiated by userId=${interaction.user.id} in guildId=${interaction.guildId}`);

		// check perms - owner or admin
		const member = interaction.member;
		const isGuildOwner = interaction.guild?.ownerId === interaction.user.id;
		const hasAdminPermission =
			member && 'permissions' in member && typeof member.permissions !== 'string' && member.permissions.has(PermissionFlagsBits.Administrator);

		if (!isGuildOwner && !hasAdminPermission) {
			await interaction.reply({
				embeds: [this.errorEmbed('You must be the **server owner** or have **Administrator** permission to delete a collection.')],
				ephemeral: true
			});
			return;
		}

		// find collection for this guild (must be owner/main)
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

		// linked servers count for the warning
		const linkedServers = Server.listByCollection(collection.id).filter((s) => s.enabled);
		const serverCount = linkedServers.length;

		const confirmEmbed = this.buildConfirmEmbed(collection, serverCount);
		const confirmButtons = this.buildConfirmButtons();

		const response = await interaction.reply({
			embeds: [confirmEmbed],
			components: [confirmButtons],
			ephemeral: true,
			fetchReply: true
		});

		const collector = response.createMessageComponentCollector({
			filter: (i) => i.user.id === interaction.user.id,
			time: 60_000 // 1 min to confirm
		});

		collector.on('collect', async (i: ButtonInteraction) => {
			if (i.customId === 'collection-delete:confirm') {
				try {
					const collectionName = collection.name;
					const collectionId = collection.id;

					// log before we delete it
					logAction({
						collectionId: collection.id,
						action: 'collection.delete',
						performedBy: interaction.user.id,
						details: {
							name: collectionName,
							mainGuildId: collection.mainGuildId,
							serverCount: serverCount
						}
					});

					collection.remove();

					console.log(
						`[CMD] /collection-delete: DELETED by userId=${interaction.user.id} collectionId=${collectionId} name="${collectionName}"`
					);

					collector.stop('confirmed');
					await i.update({
						embeds: [this.successEmbed(collectionName, collectionId)],
						components: []
					});
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
					console.log(`[CMD] /collection-delete: FAILED for userId=${interaction.user.id} error=${errorMessage}`);
					await i.reply({
						embeds: [this.errorEmbed('Failed to delete collection. Please try again.')],
						ephemeral: true
					});
				}
			} else if (i.customId === 'collection-delete:cancel') {
				console.log(`[CMD] /collection-delete: CANCELLED by userId=${interaction.user.id}`);
				collector.stop('cancelled');
				await i.update({
					embeds: [this.cancelledEmbed()],
					components: []
				});
			}
		});

		collector.on('end', async (_, reason) => {
			if (reason === 'time') {
				console.log(`[CMD] /collection-delete: timed out for userId=${interaction.user.id}`);
				await interaction.editReply({
					embeds: [this.timeoutEmbed()],
					components: []
				});
			}
		});
	}

	private buildConfirmEmbed(collection: Collection, serverCount: number): EmbedBuilder {
		const createdAtUnix = Math.floor(new Date(collection.createdAt).getTime() / 1000);

		return new EmbedBuilder()
			.setColor(WARNING_COLOR)
			.setTitle('Are you sure?')
			.setDescription(
				'You are about to **permanently delete** this collection.\n' +
					'This action **cannot be undone**. All bans, servers, moderators, and audit logs associated with this collection will be deleted.'
			)
			.addFields(
				{
					name: 'Action',
					value: '`Delete Collection`',
					inline: true
				},
				{
					name: 'Collection',
					value: `\`${collection.name}\` (ID: \`${collection.id}\`)`,
					inline: true
				},
				{
					name: 'Impact',
					value: serverCount > 0 ? `\`${serverCount} linked server(s) will be removed\`` : '`No linked servers`',
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

	private buildConfirmButtons(): ActionRowBuilder<ButtonBuilder> {
		return new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder().setCustomId('collection-delete:confirm').setLabel('Delete Permanently').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
			new ButtonBuilder().setCustomId('collection-delete:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
		);
	}

	private successEmbed(collectionName: string, collectionId: string): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(SUCCESS_COLOR)
			.setTitle('Collection Deleted')
			.setDescription('The collection has been permanently deleted.')
			.addFields(
				{
					name: 'Collection',
					value: `\`${collectionName}\``,
					inline: true
				},
				{
					name: 'ID',
					value: `\`${collectionId}\``,
					inline: true
				}
			)
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}

	private errorEmbed(message: string): EmbedBuilder {
		return new EmbedBuilder().setColor(ERROR_COLOR).setTitle('Error').setDescription(message).setFooter({ text: FOOTER_CATEGORY }).setTimestamp();
	}

	private cancelledEmbed(): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(ERROR_COLOR)
			.setTitle('Cancelled')
			.setDescription('Collection deletion was cancelled. Your collection is safe.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}

	private timeoutEmbed(): EmbedBuilder {
		return new EmbedBuilder()
			.setColor(ERROR_COLOR)
			.setTitle('Timed Out')
			.setDescription('Confirmation timed out. Your collection was not deleted.')
			.setFooter({ text: FOOTER_CATEGORY })
			.setTimestamp();
	}
}

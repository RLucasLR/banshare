import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { EmbedBuilder, InteractionContextType, PermissionFlagsBits } from 'discord.js';
import { Collection, Invite, RecordNotFoundError, Server } from '../database/models';
import { logAction } from '../lib/utils';

const FOOTER_CATEGORY = 'BanShare • Collections';
const EMBED_COLOR = 0x5865f2; // blurple
const ERROR_COLOR = 0xed4245; // red
const SUCCESS_COLOR = 0x57f287; // green
const WARNING_COLOR = 0xfee75c; // yellow

@ApplyOptions<Command.Options>({
	description: 'Invite a server to join your collection'
})
export class CollectionInviteCommand extends Command {
	public override registerApplicationCommands(registry: Command.Registry) {
		registry.registerChatInputCommand((builder) =>
			builder
				.setName('collection-invite')
				.setDescription(this.description)
				.setContexts(InteractionContextType.Guild)
				.addStringOption((option) => option.setName('server-id').setDescription('The ID of the server to invite').setRequired(true))
		);
	}

	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction): Promise<void> {
		if (!interaction.guildId) {
			await interaction.reply({
				embeds: [this.errorEmbed('This command can only be used in a server.')],
				ephemeral: true
			});
			return;
		}

		const targetGuildId = interaction.options.getString('server-id', true);

		console.log(
			`[CMD] /collection-invite initiated by userId=${interaction.user.id} in guildId=${interaction.guildId} targeting=${targetGuildId}`
		);

		// check perms
		const member = interaction.member;
		const isGuildOwner = interaction.guild?.ownerId === interaction.user.id;
		const hasAdminPermission =
			member && 'permissions' in member && typeof member.permissions !== 'string' && member.permissions.has(PermissionFlagsBits.Administrator);

		if (!isGuildOwner && !hasAdminPermission) {
			await interaction.reply({
				embeds: [this.errorEmbed('You must be the **server owner** or have **Administrator** permission to invite servers.')],
				ephemeral: true
			});
			return;
		}

		// check if owns a collection
		let collection: Collection;
		try {
			collection = Collection.getByMainGuildId(interaction.guildId);
		} catch (error) {
			if (error instanceof RecordNotFoundError) {
				await interaction.reply({
					embeds: [this.errorEmbed('This server does not own a collection. Use `/collection-create` to create one first.')],
					ephemeral: true
				});
				return;
			}
			throw error;
		}

		// validate guild id format
		if (!/^\d{17,20}$/.test(targetGuildId)) {
			await interaction.reply({
				embeds: [this.errorEmbed('Invalid server ID format. Please provide a valid Discord server ID.')],
				ephemeral: true
			});
			return;
		}

		// cant invite self
		if (targetGuildId === interaction.guildId) {
			await interaction.reply({
				embeds: [this.errorEmbed('You cannot invite your own server to your collection.')],
				ephemeral: true
			});
			return;
		}

		// check pending invite
		if (Invite.hasPendingInvite(collection.id, targetGuildId)) {
			await interaction.reply({
				embeds: [
					this.errorEmbed(
						'There is already a pending invite for this server. Wait for them to respond or for the invite to expire (48 hours).'
					)
				],
				ephemeral: true
			});
			return;
		}

		// try get target guild
		let targetGuild;
		try {
			targetGuild = await Promise.race([
				this.container.client.guilds.fetch(targetGuildId),
				new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
			]);
		} catch {
			targetGuild = null;
		}
		if (!targetGuild) {
			await interaction.reply({
				embeds: [this.errorEmbed('Could not find a server with that ID. Make sure the bot is in that server.')],
				ephemeral: true
			});
			return;
		}

		// check if target already in a collection
		let isAlreadyInCollection = false;
		try {
			Server.getByGuildId(targetGuildId);
			isAlreadyInCollection = true;
		} catch (error) {
			if (!(error instanceof RecordNotFoundError)) throw error;
		}

		// defer - dms might take a bit
		await interaction.deferReply({ ephemeral: true });

		try {
			// create invite
			const invite = Invite.create({
				collectionId: collection.id,
				targetGuildId,
				invitedBy: interaction.user.id
			});

			const expiresAtUnix = Math.floor(new Date(invite.expiresAt).getTime() / 1000);

			// get target owner with timeout
			let targetOwner;
			try {
				targetOwner = await Promise.race([
					targetGuild.fetchOwner(),
					new Promise<null>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
				]);
			} catch {
				targetOwner = null;
			}

			// invite notif embed
			const inviteEmbed = new EmbedBuilder()
				.setColor(EMBED_COLOR)
				.setTitle('📬 Collection Invite Received')
				.setDescription(
					`Your server **${targetGuild.name}** has been invited to join a BanShare collection!\n\n` +
						`**Collection:** \`${collection.name}\`\n` +
						`**Invited by:** <@${interaction.user.id}> from **${interaction.guild!.name}**`
				)
				.addFields(
					{
						name: 'Expires',
						value: `<t:${expiresAtUnix}:F> (<t:${expiresAtUnix}:R>)`,
						inline: false
					},
					{
						name: 'How to Join',
						value: isAlreadyInCollection
							? '⚠️ Your server is already in a collection. You must leave your current collection before joining a new one. If you wish to switch, leave your current collection first and then run `/collection-join` in your server.'
							: 'Run `/collection-join` in your server to accept this invite.',
						inline: false
					}
				)
				.setFooter({ text: FOOTER_CATEGORY })
				.setTimestamp();

			// track dms
			const dmSuccesses: string[] = [];
			const dmFailures: string[] = [];

			// dm target owner
			if (targetOwner) {
				try {
					await targetOwner.send({ embeds: [inviteEmbed] });
					dmSuccesses.push(`Owner: <@${targetOwner.id}>`);
				} catch {
					dmFailures.push(`Owner: <@${targetOwner.id}> (DMs disabled)`);
				}
			}

			// only dm owner (skip slow member fetches on big servers)

			// build response
			let resultDescription = `Successfully sent an invite to **${targetGuild.name}**!\n\n`;

			if (isAlreadyInCollection) {
				resultDescription +=
					'⚠️ **Note:** This server is already in a collection. They have been notified but will need to leave their current collection before they can join yours. You may need to invite them again after they leave.\n\n';
			}

			resultDescription += `The invite will expire <t:${expiresAtUnix}:R>.\n\n`;

			if (dmSuccesses.length > 0) {
				resultDescription += `**Notified:**\n${dmSuccesses.join('\n')}\n\n`;
			}
			if (dmFailures.length > 0) {
				resultDescription += `**Could not notify:**\n${dmFailures.join('\n')}`;
			}

			const successEmbed = new EmbedBuilder()
				.setColor(isAlreadyInCollection ? WARNING_COLOR : SUCCESS_COLOR)
				.setTitle(isAlreadyInCollection ? 'Invite Sent (With Warning)' : 'Invite Sent')
				.setDescription(resultDescription)
				.addFields(
					{
						name: 'Collection',
						value: `\`${collection.name}\``,
						inline: true
					},
					{
						name: 'Target Server',
						value: `\`${targetGuild.name}\``,
						inline: true
					},
					{
						name: 'Invite ID',
						value: `\`${invite.id}\``,
						inline: true
					}
				)
				.setFooter({ text: FOOTER_CATEGORY })
				.setTimestamp();

			await interaction.editReply({ embeds: [successEmbed] });

			console.log(`[CMD] /collection-invite: Created invite id=${invite.id} for guildId=${targetGuildId} to collectionId=${collection.id}`);

			// audit
			logAction({
				collectionId: collection.id,
				action: 'invite.create',
				performedBy: interaction.user.id,
				details: {
					inviteId: invite.id,
					targetGuildId: targetGuildId,
					expiresAt: invite.expiresAt
				}
			});
		} catch (error) {
			console.error(`[CMD] /collection-invite: Error creating invite`, error);
			await interaction.editReply({
				embeds: [this.errorEmbed('An error occurred while creating the invite. Please try again.')]
			});
		}
	}

	private errorEmbed(message: string): EmbedBuilder {
		return new EmbedBuilder().setColor(ERROR_COLOR).setTitle('Error').setDescription(message).setFooter({ text: FOOTER_CATEGORY }).setTimestamp();
	}
}

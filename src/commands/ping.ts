import { ApplyOptions } from '@sapphire/decorators';
import { Command } from '@sapphire/framework';
import { randomInt } from 'crypto';
import { ApplicationCommandType, ApplicationIntegrationType, InteractionContextType, Message } from 'discord.js';

const randomDescriptionSuffix = String(randomInt(100_000_000, 1_000_000_000));

@ApplyOptions<Command.Options>({
	description: 'ping pong'
})
export class UserCommand extends Command {
	// register slash and context menu
	public override registerApplicationCommands(registry: Command.Registry) {
		// shared integration types for guilds and dms
		const integrationTypes: ApplicationIntegrationType[] = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
		const contexts: InteractionContextType[] = [
			InteractionContextType.BotDM,
			InteractionContextType.Guild,
			InteractionContextType.PrivateChannel
		];

		// slash command
		registry.registerChatInputCommand({
			name: this.name,
			description: `${this.description} ${randomDescriptionSuffix}`,
			integrationTypes,
			contexts
		});

		// context menu from message
		registry.registerContextMenuCommand({
			name: this.name,
			type: ApplicationCommandType.Message,
			integrationTypes,
			contexts
		});

		// context menu from user
		registry.registerContextMenuCommand({
			name: this.name,
			type: ApplicationCommandType.User,
			integrationTypes,
			contexts
		});
	}

	// msg command
	public override async messageRun(message: Message) {
		return this.sendPing(message);
	}

	// slash
	public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
		return this.sendPing(interaction);
	}

	// ctx menu
	public override async contextMenuRun(interaction: Command.ContextMenuCommandInteraction) {
		return this.sendPing(interaction);
	}

	private async sendPing(interactionOrMessage: Message | Command.ChatInputCommandInteraction | Command.ContextMenuCommandInteraction) {
		const pingMessage =
			interactionOrMessage instanceof Message
				? interactionOrMessage.channel?.isSendable() && (await interactionOrMessage.channel.send({ content: 'Ping?' }))
				: await interactionOrMessage.reply({ content: 'Ping?', fetchReply: true });

		if (!pingMessage) return;

		const content = `Pong! Bot Latency ${Math.round(this.container.client.ws.ping)}ms. API Latency ${
			pingMessage.createdTimestamp - interactionOrMessage.createdTimestamp
		}ms.`;

		if (interactionOrMessage instanceof Message) {
			return pingMessage.edit({ content });
		}

		return interactionOrMessage.editReply({
			content
		});
	}
}

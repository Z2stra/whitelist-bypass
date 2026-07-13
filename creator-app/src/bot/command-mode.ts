export enum BotCommandMode {
  Operational = 'operational',
  PocOnly = 'poc-only',
}

export const VK_POC_ONLY_FLAG = '--vk-poc-only';

export function resolveBotCommandMode(argv: readonly string[]): BotCommandMode {
  return argv.includes(VK_POC_ONLY_FLAG)
    ? BotCommandMode.PocOnly
    : BotCommandMode.Operational;
}

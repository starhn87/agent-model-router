const PROVIDER = "agent_router";

export function codexChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  delete childEnv.TYPESAFE_API_KEY;
  delete childEnv.JEV_API_KEY;
  return childEnv;
}

export function codexArgs(baseUrl: string, baselineModel: string, args: string[]): string[] {
  const hasManualModel = args.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="));
  return [
    ...(hasManualModel ? [] : ["--model", baselineModel]),
    "--config", `model_provider="${PROVIDER}"`,
    "--config", `model_providers.${PROVIDER}.name="Jev Agent Optimizer"`,
    "--config", `model_providers.${PROVIDER}.base_url="${baseUrl}"`,
    "--config", `model_providers.${PROVIDER}.wire_api="responses"`,
    "--config", `model_providers.${PROVIDER}.requires_openai_auth=true`,
    "--config", `model_providers.${PROVIDER}.supports_websockets=false`,
    ...args,
  ];
}

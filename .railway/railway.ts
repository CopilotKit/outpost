// Railway Infrastructure as Code - Outpost services
// https://docs.railway.com/infrastructure-as-code
//
// Takes over from the per-service railway.toml files (Config as Code), which
// Railway stops reading on 2026-12-01 (same page). Unlike Config as Code, this
// file is NOT read at deploy time: changes reach Railway only through
// `railway config apply`, so editing a setting here and merging does nothing
// until someone applies it. Needs Railway CLI 5.42.1 or newer.
//
// `partial` limits what this file owns to the services declared below. A
// whole-project file deletes every resource it omits on apply, and this file
// does not declare the Postgres databases, so without it an apply would plan to
// delete them.
//
// Cutover. The change that adds this file also deletes the railway.toml files,
// so a service still pointed at one has no build config until it is applied.
//   1. Before merging: `railway config pull` in each environment and copy its
//      variables in as preserve(), along with its domains (custom and
//      *.up.railway.app: the webhook services' URLs are registered with
//      GitHub, Linear and Teams). Then add the environment to
//      VARIABLES_IMPORTED.
//   2. When the change reaches an environment's deploy branch (`main` for
//      production, `staging` for staging), in the same sitting:
//      a. Clear every service's "Config file path" in the dashboard. IaC
//         cannot manage a service that Config as Code still manages.
//      b. `railway config plan`. It may change only the build and deploy
//         settings this file sets. Stop if it removes or changes anything else:
//         variables, domains, replicas, dashboard-only settings, the deploy
//         trigger of slack-bot, teams-bot or linear-sync, or (in staging) an
//         outpost-release-bot service.
//      c. `railway config apply`.
//
// Build context is the repo ROOT for every service (the Dockerfiles run
// `turbo prune`), so no service sets a root directory.

import { defineRailway, github, service } from 'railway/iac';

export const partial = 'outpost-services';

// Environments whose variables from `railway config pull` are in this file.
// Each one is listed separately because staging and production hold different
// values: importing staging's does nothing to protect production's.
const VARIABLES_IMPORTED: Environment[] = [];

// Each environment deploys from its own branch: staging from `staging`,
// production from `main`. Anything else is an error rather than a silent
// fallback to `main`.
const BRANCHES = {
    production: 'main',
    staging: 'staging',
} as const;

type Environment = keyof typeof BRANCHES;

const isEnvironment = (name: string): name is Environment => Object.hasOwn(BRANCHES, name);

export default defineRailway((ctx, project) => {
    const environment = ctx.environmentName ?? ctx.environment;
    if (!environment) {
        throw new Error(
            'No Railway environment selected. Link one with `railway environment` first.',
        );
    }
    if (!isEnvironment(environment)) {
        throw new Error(
            `No branch mapped for Railway environment "${environment}". ` +
                `Known environments: ${Object.keys(BRANCHES).join(', ')}.`,
        );
    }
    const branch = BRANCHES[environment];

    // Railway does not document which command it passes here, so a run without
    // one is treated as read-only. That
    // makes this guard catch an apply only when the CLI says `apply`; the plan
    // check in cutover step 2b stays the real safety net.
    const readOnly = ctx.command === undefined || ctx.command === 'plan' || ctx.command === 'pull';
    if (!VARIABLES_IMPORTED.includes(environment) && !readOnly) {
        throw new Error(
            `Variables for "${environment}" are not declared in .railway/railway.ts yet, so an apply would delete them. ` +
                'Import them with `railway config pull` first (see the cutover steps at the top of the file).',
        );
    }

    // checkSuites turns on "wait for CI": a push deploys only after the CI check
    // suite passes on that commit, as both environments do today.
    const deployed = github('CopilotKit/outpost', { branch, checkSuites: true });

    // slack-bot, teams-bot and linear-sync are optional integrations, deployed
    // by hand and left offline until their credentials are configured, so this
    // file does not set a branch for them. github() defaults the branch to
    // `main`, which would add a deploy trigger, so it is passed as null; the SDK
    // then drops the key, leaving the branch out of the plan. Cutover step 2b
    // checks that Railway reads that as "no change".
    const manual = github('CopilotKit/outpost', { branch: null });

    const dockerfile = (app: string) => ({
        builder: 'DOCKERFILE' as const,
        dockerfilePath: `apps/${app}/Dockerfile`,
    });

    // web's healthcheck was set in the dashboard, not in its railway.toml. It is
    // declared here so it is version-controlled like the other services'. Its
    // other dashboard-only settings are left out; cutover step 2b checks that
    // the plan leaves them alone.
    const web = service('outpost-web', {
        source: deployed,
        build: dockerfile('web'),
        deploy: { healthcheckPath: '/api/health' },
    });

    const discordBot = service('outpost-discord-bot', {
        source: deployed,
        build: dockerfile('discord-bot'),
        deploy: { restartPolicyType: 'ALWAYS' },
    });

    const githubApp = service('outpost-github-app', {
        source: deployed,
        build: dockerfile('github-app'),
        deploy: { restartPolicyType: 'ALWAYS', healthcheckPath: '/health' },
    });

    const linearSync = service('outpost-linear-sync', {
        source: manual,
        build: dockerfile('linear-sync'),
        deploy: { restartPolicyType: 'ALWAYS', healthcheckPath: '/health' },
    });

    const slackBot = service('outpost-slack-bot', {
        source: manual,
        build: dockerfile('slack-bot'),
        deploy: { restartPolicyType: 'ALWAYS' },
    });

    const teamsBot = service('outpost-teams-bot', {
        source: manual,
        build: dockerfile('teams-bot'),
        deploy: { restartPolicyType: 'ALWAYS', healthcheckPath: '/health' },
    });

    const worker = service('outpost-worker', {
        source: deployed,
        build: dockerfile('worker'),
        deploy: { restartPolicyType: 'ALWAYS', healthcheckPath: '/health' },
    });

    const resources = [web, discordBot, githubApp, linearSync, slackBot, teamsBot, worker];

    // The release bot runs in production only: it posts to the community
    // Discord channels, so a staging copy would announce the same releases twice.
    if (environment === 'production') {
        // A cron job, not a long-running process: it announces whatever is new
        // and exits. restartPolicyType NEVER because a completed run exiting 0
        // is success, not a crash; ALWAYS would restart it in a loop and run the
        // job back to back.
        //
        // watchPatterns keeps unrelated pushes from redeploying it. Every entry
        // is anchored with a leading slash: these are gitignore-style patterns,
        // so an unanchored `package.json` would match every package.json in the
        // repo. If the release bot ever depends on a workspace package, add
        // `/packages/**` here, or changes to that package will not redeploy it.
        const releaseBot = service('outpost-release-bot', {
            source: deployed,
            build: {
                ...dockerfile('release-bot'),
                watchPatterns: [
                    '/apps/release-bot/**',
                    '!/apps/release-bot/README.md',
                    '!/apps/release-bot/.env.example',
                    '!/apps/release-bot/src/__tests__/**',
                    '!/apps/release-bot/vitest.config.ts',
                    '!/apps/release-bot/tsconfig.test.json',
                    '/package.json',
                    '/pnpm-lock.yaml',
                    '/pnpm-workspace.yaml',
                    '/.npmrc',
                    '/tsconfig.json',
                    '/turbo.json',
                    '/.dockerignore',
                ],
            },
            deploy: { restartPolicyType: 'NEVER', cronSchedule: '0 * * * *' },
        });
        resources.push(releaseBot);
    }

    return project('outpost', { resources });
});

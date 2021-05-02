const { JsiiProject, JsonFile, TextFile } = require('./lib');

const project = new JsiiProject({
  name: 'projen',
  description: 'CDK for software projects',
  repository: 'https://github.com/projen/projen.git',
  authorName: 'Elad Ben-Israel',
  authorEmail: 'benisrae@amazon.com',
  stability: 'experimental',

  // this will cause PR builds to auto update the
  // branch with changes to generated files (experimental)
  buildWorkflowMutable: true,

  pullRequestTemplateContents: [
    '---',
    'By submitting this pull request, I confirm that my contribution is made under the terms of the Apache 2.0 license.',
  ],

  testdir: 'src/__tests__',

  bundledDeps: [
    'yaml',
    'fs-extra',
    'yargs',
    'decamelize',
    'glob@^7',
    'semver',
    'inquirer',
    'chalk',
    '@iarna/toml',
    'xmlbuilder2',
    'ini',
    'shelljs',
  ],

  devDeps: [
    '@types/fs-extra@^8',
    '@types/yargs',
    '@types/glob',
    '@types/inquirer',
    '@types/semver',
    '@types/ini',
    '@types/shelljs',
    'markmac',
    'all-contributors-cli',
  ],

  projenDevDependency: false, // because I am projen
  releaseToNpm: true,
  minNodeVersion: '10.17.0',
  codeCov: true,
  defaultReleaseBranch: 'main',
  gitpod: true,
  devContainer: true,
  // since this is projen, we need to always compile before we run
  projenCommand: '/bin/bash ./projen.bash',

  // makes it very hard to iterate with jest --watch
  jestOptions: {
    coverageText: false,
  },

  publishToMaven: {
    javaPackage: 'org.projen',
    mavenGroupId: 'com.github.eladb',
    mavenArtifactId: 'projen',
  },

  publishToPypi: {
    distName: 'projen',
    module: 'projen',
  },

  // Disabled due to cycles between main module and submodules
  // publishToGo: {
  //   moduleName: 'github.com/projen/projen-go',
  // },
});

// temporary until https://github.com/aws/jsii/pull/2492 is resolved
// project.packageTask.exec('echo $(node -p "require(\'./version.json\').version") > dist/go/projen/version');

// this script is what we use as the projen command in this project
// it will compile the project if needed and then run the cli.
new TextFile(project, 'projen.bash', {
  lines: [
    '#!/bin/bash',
    `# ${TextFile.PROJEN_MARKER}`,
    'set -euo pipefail',
    'if [ ! -f lib/cli/index.js ]; then',
    '  echo "compiling the cli..."',
    `  ${project.compileTask.toShellCommand()}`,
    'fi',
    'exec bin/projen $@',
  ],
});

project.addExcludeFromCleanup('src/__tests__/**');
project.gitignore.include('templates/**');

// expand markdown macros in readme
const macros = project.addTask('readme-macros');
macros.exec('mv README.md README.md.bak');
macros.exec('cat README.md.bak | markmac > README.md');
macros.exec('rm README.md.bak');
project.buildTask.spawn(macros);

new JsonFile(project, '.markdownlint.json', {
  obj: {
    'default': true,
    'commands-show-output': false,
    'line-length': {
      line_length: 200,
    },
  },
});

project.vscode.launchConfiguration.addConfiguration({
  type: 'pwa-node',
  request: 'launch',
  name: 'projen CLI',
  skipFiles: [
    '<node_internals>/**',
  ],
  program: '${workspaceFolder}/lib/cli/index.js',
  outFiles: [
    '${workspaceFolder}/lib/**/*.js',
  ],
});

project.github.mergify.addRule({
  name: 'Label core contributions',
  actions: {
    label: {
      add: ['contribution/core'],
    },
  },
  conditions: [
    'author~=^(eladb)$',
    'label!=contribution/core',
  ],
});

project.gitpod.addCustomTask({
  name: 'Setup',
  init: 'yarn install',
  prebuild: 'bash ./projen.bash',
  command: 'npx projen build',
});

const setup = project.addTask('devenv:setup');
setup.exec('yarn install');
setup.spawn(project.buildTask);
project.devContainer.addTasks(setup);

project.addTask('contributors:update', {
  exec: 'all-contributors check | tail -n1 | sed -e "s/,//g" | xargs -n1 | grep -v "\[bot\]" | xargs -n1 -I{} all-contributors add {} code',
});

project.synth();

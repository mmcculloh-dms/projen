import { mkdtempSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { cleanup } from './cleanup';
import { Clobber } from './clobber';
import { IS_TEST_RUN, PROJEN_VERSION } from './common';
import { Component } from './component';
import { Dependencies } from './deps';
import { FileBase } from './file';
import { GitAttributesFile } from './git/gitattributes';
import { AutoApprove, AutoApproveOptions, AutoMergeOptions, GitHub, GitHubOptions, MergifyOptions } from './github';
import { Stale, StaleOptions } from './github/stale';
import { Gitpod } from './gitpod';
import { IgnoreFile } from './ignore-file';
import * as inventory from './inventory';
import { resolveNewProject } from './javascript/render-options';
import { JsonFile } from './json';
import { Projenrc, ProjenrcOptions } from './json/index';
import { Logger, LoggerOptions } from './logger';
import { ObjectFile } from './object-file';
import { NewProjectOptionHints } from './option-hints';
import { ProjectBuild as ProjectBuild } from './project-build';
import { SampleReadme, SampleReadmeProps } from './readme';
import { Task, TaskOptions } from './tasks';
import { Tasks } from './tasks/tasks';
import { isTruthy } from './util';
import { VsCode, DevContainer } from './vscode';

/**
 * Options for `Project`.
 */
export interface ProjectOptions {
  /**
   * This is the name of your project.
   *
   * @default $BASEDIR
   * @featured
   */
  readonly name: string;

  /**
   * The parent project, if this project is part of a bigger project.
   */
  readonly parent?: Project;

  /**
   * The root directory of the project.
   *
   * Relative to this directory, all files are synthesized.
   *
   * If this project has a parent, this directory is relative to the parent
   * directory and it cannot be the same as the parent or any of it's other
   * sub-projects.
   *
   * @default "."
   */
  readonly outdir?: string;

  /**
   * Configure logging options such as verbosity.
   * @default {}
   */
  readonly logging?: LoggerOptions;

  /**
   * Generate (once) .projenrc.json (in JSON). Set to `false` in order to disable
   * .projenrc.json generation.
   *
   * @default false
   */
  readonly projenrcJson?: boolean;

  /**
    * Options for .projenrc.json
    * @default - default options
    */
  readonly projenrcJsonOptions?: ProjenrcOptions;

  /**
   * The shell command to use in order to run the projen CLI.
   *
   * Can be used to customize in special environments.
   *
   * @default "npx projen"
   */
  readonly projenCommand?: string;
}

/**
 * Base project
 */
export class Project {
  /**
   * The name of the default task (the task executed when `projen` is run without arguments). Normally
   * this task should synthesize the project files.
   */
  public static readonly DEFAULT_TASK = 'default';

  /**
   * Project name.
   */
  public readonly name: string;

  /**
   * .gitignore
   */
  public readonly gitignore: IgnoreFile;


  /**
   * The .gitattributes file for this repository.
   */
  public readonly gitattributes: GitAttributesFile;


  /**
   * A parent project. If undefined, this is the root project.
   */
  public readonly parent?: Project;

  /**
   * Absolute output directory of this project.
   */
  public readonly outdir: string;

  /**
   * The root project.
   **/
  public readonly root: Project;

  /**
   * Project tasks.
   */
  public readonly tasks: Tasks;

  /**
   * Project dependencies.
   */
  public readonly deps: Dependencies;

  /**
   * Logging utilities.
   */
  public readonly logger: Logger;

  /**
   * The options used when this project is bootstrapped via `projen new`. It
   * includes the original set of options passed to the CLI and also the JSII
   * FQN of the project type.
   */
  public readonly newProject?: NewProject;

  /**
   * The command to use in order to run the projen CLI.
   */
  public readonly projenCommand: string;

  /**
   * This is the "default" task, the one that executes "projen".
   */
  public readonly defaultTask: Task;

  /**
   * Manages the build process of the project.
   */
  public readonly projectBuild: ProjectBuild;

  private readonly _components = new Array<Component>();
  private readonly subprojects = new Array<Project>();
  private readonly tips = new Array<string>();
  private readonly excludeFromCleanup: string[];

  constructor(options: ProjectOptions) {
    this.newProject = resolveNewProject(options);

    this.name = options.name;
    this.parent = options.parent;
    this.excludeFromCleanup = [];
    this.projenCommand = options.projenCommand ?? 'npx projen';

    this.outdir = this.determineOutdir(options.outdir);
    this.root = this.parent ? this.parent.root : this;

    // must happen after this.outdir, this.parent and this.root are initialized
    this.parent?._addSubProject(this);

    // ------------------------------------------------------------------------

    this.gitattributes = new GitAttributesFile(this);
    this.annotateGenerated('/.projen/**'); // contents  of the .projen/ directory are generated by projen
    this.annotateGenerated(`/${this.gitattributes.path}`); // the .gitattributes file itself is generated

    this.gitignore = new IgnoreFile(this, '.gitignore');
    this.gitignore.exclude('node_modules/'); // created by running `npx projen`
    this.gitignore.include(`/${this.gitattributes.path}`);

    // oh no: tasks depends on gitignore so it has to be initialized after
    // smells like dep injectionn but god forbid.
    this.tasks = new Tasks(this);

    this.defaultTask = this.tasks.addTask(Project.DEFAULT_TASK, {
      description: 'Synthesize project files',
    });

    this.projectBuild = new ProjectBuild(this);

    this.deps = new Dependencies(this);

    this.logger = new Logger(this, options.logging);

    const projenrcJson = options.projenrcJson ?? false;
    if (projenrcJson) {
      new Projenrc(this, options.projenrcJsonOptions);
    }
  }

  /**
   * Returns all the components within this project.
   */
  public get components() {
    return [...this._components];
  }

  /**
   * All files in this project.
   */
  public get files(): FileBase[] {
    const isFile = (c: Component): c is FileBase => c instanceof FileBase;
    return this._components.filter(isFile).sort((f1, f2) => f1.path.localeCompare(f2.path));
  }

  /**
   * Adds a new task to this project. This will fail if the project already has
   * a task with this name.
   *
   * @param name The task name to add
   * @param props Task properties
   */
  public addTask(name: string, props: TaskOptions = { }) {
    return this.tasks.addTask(name, props);
  }

  /**
   * Removes a task from a project.
   *
   * @param name The name of the task to remove.
   *
   * @returns The `Task` that was removed, otherwise `undefined`.
   */
  public removeTask(name: string) {
    return this.tasks.removeTask(name);
  }

  public get buildTask() { return this.projectBuild.buildTask; }
  public get compileTask() { return this.projectBuild.compileTask; }
  public get testTask() { return this.projectBuild.testTask; }
  public get preCompileTask() { return this.projectBuild.preCompileTask; }
  public get postCompileTask() { return this.projectBuild.postCompileTask; }
  public get packageTask() { return this.projectBuild.packageTask; }

  /**
   * Finds a file at the specified relative path within this project and all
   * its subprojects.
   *
   * @param filePath The file path. If this path is relative, it will be resolved
   * from the root of _this_ project.
   * @returns a `FileBase` or undefined if there is no file in that path
   */
  public tryFindFile(filePath: string): FileBase | undefined {
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(this.outdir, filePath);
    for (const file of this.files) {
      if (absolute === file.absolutePath) {
        return file;
      }
    }

    for (const child of this.subprojects) {
      const file = child.tryFindFile(absolute);
      if (file) {
        return file;
      }
    }

    return undefined;
  }

  /**
   * Finds a json file by name.
   * @param filePath The file path.
   * @deprecated use `tryFindObjectFile`
   */
  public tryFindJsonFile(filePath: string): JsonFile | undefined {
    const file = this.tryFindObjectFile(filePath);
    if (!file) {
      return undefined;
    }

    if (!(file instanceof JsonFile)) {
      throw new Error(`found file ${filePath} but it is not a JsonFile. got: ${file.constructor.name}`);
    }

    return file;
  }

  /**
   * Finds an object file (like JsonFile, YamlFile, etc.) by name.
   * @param filePath The file path.
   */
  public tryFindObjectFile(filePath: string): ObjectFile | undefined {
    const file = this.tryFindFile(filePath);
    if (!file) {
      return undefined;
    }

    if (!(file instanceof ObjectFile)) {
      throw new Error(`found file ${filePath} but it is not a ObjectFile. got: ${file.constructor.name}`);
    }

    return file;
  }

  /**
   * Prints a "tip" message during synthesis.
   * @param message The message
   * @deprecated - use `project.logger.info(message)` to show messages during synthesis
   */
  public addTip(message: string) {
    this.tips.push(message);
  }

  /**
   * Exclude the matching files from pre-synth cleanup. Can be used when, for example, some
   * source files include the projen marker and we don't want them to be erased during synth.
   *
   * @param globs The glob patterns to match
   */
  public addExcludeFromCleanup(...globs: string[]) {
    this.excludeFromCleanup.push(...globs);
  }

  /**
   * Returns the shell command to execute in order to run a task.
   *
   * By default, this is `npx projen@<version> <task>`
   *
   * @param task The task for which the command is required
   */
  public runTaskCommand(task: Task) {
    return `npx projen@${PROJEN_VERSION} ${task.name}`;
  }

  /**
   * Exclude these files from the bundled package. Implemented by project types based on the
   * packaging mechanism. For example, `NodeProject` delegates this to `.npmignore`.
   *
   * @param _pattern The glob pattern to exclude
   */
  public addPackageIgnore(_pattern: string) {
    // nothing to do at the abstract level
  }

  /**
   * Adds a .gitignore pattern.
   * @param pattern The glob pattern to ignore.
   */
  public addGitIgnore(pattern: string) {
    this.gitignore.addPatterns(pattern);
  }

  /**
   * Consider a set of files as "generated". This method is implemented by
   * derived classes and used for example, to add git attributes to tell GitHub
   * that certain files are generated.
   *
   * @param _glob the glob pattern to match (could be a file path).
   */
  public annotateGenerated(_glob: string): void {
    // nothing to do at the abstract level
  }

  /**
   * Synthesize all project files into `outdir`.
   *
   * 1. Call "this.preSynthesize()"
   * 2. Delete all generated files
   * 3. Synthesize all sub-projects
   * 4. Synthesize all components of this project
   * 5. Call "postSynthesize()" for all components of this project
   * 6. Call "this.postSynthesize()"
   */
  public synth(): void {
    const outdir = this.outdir;
    this.logger.debug('Synthesizing project...');

    this.preSynthesize();

    for (const comp of this._components) {
      comp.preSynthesize();
    }

    // we exclude all subproject directories to ensure that when subproject.synth()
    // gets called below after cleanup(), subproject generated files are left intact
    for (const subproject of this.subprojects) {
      this.addExcludeFromCleanup(subproject.outdir + '/**');
    }

    // delete all generated files before we start synthesizing new ones
    cleanup(outdir, this.excludeFromCleanup);

    for (const subproject of this.subprojects) {
      subproject.synth();
    }

    for (const comp of this._components) {
      comp.synthesize();
    }

    if (!isTruthy(process.env.PROJEN_DISABLE_POST)) {
      for (const comp of this._components) {
        comp.postSynthesize();
      }

      // project-level hook
      this.postSynthesize();
    }

    this.logger.debug('Synthesis complete');
  }

  /**
   * Called before all components are synthesized.
   */
  public preSynthesize() {}

  /**
   * Called after all components are synthesized. Order is *not* guaranteed.
   */
  public postSynthesize() {}

  /**
   * Adds a component to the project.
   * @internal
   */
  public _addComponent(component: Component) {
    this._components.push(component);
  }

  /**
   * Adds a sub-project to this project.
   *
   * This is automatically called when a new project is created with `parent`
   * pointing to this project, so there is no real need to call this manually.
   *
   * @param sub-project The child project to add.
   * @internal
   */
  _addSubProject(subproject: Project) {
    if (subproject.parent !== this) {
      throw new Error('"parent" of child project must be this project');
    }

    // check that `outdir` is exclusive
    for (const p of this.subprojects) {
      if (path.resolve(p.outdir) === path.resolve(subproject.outdir)) {
        throw new Error(`there is already a sub-project with "outdir": ${subproject.outdir}`);
      }
    }

    this.subprojects.push(subproject);
  }

  /**
   * Resolves the project's output directory.
   */
  private determineOutdir(outdirOption?: string) {
    if (this.parent && outdirOption && path.isAbsolute(outdirOption)) {
      throw new Error('"outdir" must be a relative path');
    }

    // if this is a subproject, it is relative to the parent
    if (this.parent) {
      if (!outdirOption) {
        throw new Error('"outdir" must be specified for subprojects');
      }

      return path.resolve(this.parent.outdir, outdirOption);
    }

    // if this is running inside a test, use a temp directory (unless cwd is aleady under tmp)
    if (IS_TEST_RUN && !outdirOption) {
      const realCwd = realpathSync(process.cwd());
      const realTmp = realpathSync(tmpdir());

      if (realCwd.startsWith(realTmp)) {
        return path.resolve(realCwd, outdirOption ?? '.');
      }

      return mkdtempSync(path.join(tmpdir(), 'projen.'));
    }

    return path.resolve(outdirOption ?? '.');
  }
}


/**
 * Which type of project this is.
 *
 * @deprecated no longer supported at the base project level
 */
export enum ProjectType {
  /**
   * This module may be a either a library or an app.
   */
  UNKNOWN = 'unknown',

  /**
   * This is a library, intended to be published to a package manager and
   * consumed by other projects.
   */
  LIB = 'lib',

  /**
   * This is an app (service, tool, website, etc). Its artifacts are intended to
   * be deployed or published for end-user consumption.
   */
  APP = 'app'
}

/**
 * Information passed from `projen new` to the project object when the project
 * is first created. It is used to generate projenrc files in various languages.
 */
export interface NewProject {
  /**
   * The JSII FQN of the project type.
   */
  readonly fqn: string;

  /**
   * Initial arguments passed to `projen new`.
   */
  readonly args: Record<string, any>;

  /**
   * Project metadata.
   */
  readonly type: inventory.ProjectType;

  /**
   * Include commented out options. Does not apply to projenrc.json files.
   * @default NewProjectOptionHints.FEATURED
   */
  readonly comments: NewProjectOptionHints;
}

/**
 * Options for `GitHubProject`.
 */
export interface GitHubProjectOptions extends ProjectOptions {
  /**
   * Add a Gitpod development environment
   *
   * @default false
   */
  readonly gitpod?: boolean;

  /**
   * Enable VSCode integration.
   *
   * Enabled by default for root projects. Disabled for non-root projects.
   *
   * @default true
   */
  readonly vscode?: boolean;

  /**
   * Enable GitHub integration.
   *
   * Enabled by default for root projects. Disabled for non-root projects.
   *
   * @default true
   */
  readonly github?: boolean;

  /**
   * Options for GitHub integration
   *
   * @default - see GitHubOptions
   */
  readonly githubOptions?: GitHubOptions;

  /**
   * Whether mergify should be enabled on this repository or not.
   *
   * @default true
   * @deprecated use `githubOptions.mergify` instead
   */
  readonly mergify?: boolean;

  /**
   * Options for mergify
   *
   * @default - default options
   * @deprecated use `githubOptions.mergifyOptions` instead
   */
  readonly mergifyOptions?: MergifyOptions;

  /**
   * Add a VSCode development environment (used for GitHub Codespaces)
   *
   * @default false
   */
  readonly devContainer?: boolean;

  /**
   * Add a `clobber` task which resets the repo to origin.
   * @default true
   */
  readonly clobber?: boolean;

  /**
   * The README setup.
   *
   * @default - { filename: 'README.md', contents: '# replace this' }
   * @example "{ filename: 'readme.md', contents: '# title' }"
   */
  readonly readme?: SampleReadmeProps;

  /**
   * Which type of project this is (library/app).
   * @default ProjectType.UNKNOWN
   * @deprecated no longer supported at the base project level
   */
  readonly projectType?: ProjectType;

  /**
   * Enable and configure the 'auto approve' workflow.
   * @default - auto approve is disabled
   */
  readonly autoApproveOptions?: AutoApproveOptions;

  /**
   * Configure options for automatic merging on GitHub. Has no effect if
   * `github.mergify` is set to false.
   *
   * @default - see defaults in `AutoMergeOptions`
   */
  readonly autoMergeOptions?: AutoMergeOptions;

  /**
   * Auto-close stale issues and pull requests. To disable set `stale` to `false`.
   *
   * @default - see defaults in `StaleOptions`
   */
  readonly staleOptions?: StaleOptions;

  /**
   * Auto-close of stale issues and pull request. See `staleOptions` for options.
   *
   * @default true
   */
  readonly stale?: boolean;
}

/**
 * GitHub-based project.
 *
 * @deprecated This is a *temporary* class. At the moment, our base project
 * types such as `NodeProject` and `JavaProject` are derived from this, but we
 * want to be able to use these project types outside of GitHub as well. One of
 * the next steps to address this is to abstract workflows so that different
 * "engines" can be used to implement our CI/CD solutions.
 */
export class GitHubProject extends Project {
  /**
   * Access all github components.
   *
   * This will be `undefined` for subprojects.
   */
  public readonly github: GitHub | undefined;

  /**
   * Access all VSCode components.
   *
   * This will be `undefined` for subprojects.
   */
  public readonly vscode: VsCode | undefined;

  /**
   * Access for Gitpod
   *
   * This will be `undefined` if gitpod boolean is false
   */
  public readonly gitpod: Gitpod | undefined;

  /**
   * Access for .devcontainer.json (used for GitHub Codespaces)
   *
   * This will be `undefined` if devContainer boolean is false
   */
  public readonly devContainer: DevContainer | undefined;

  /*
   * Which project type this is.
   *
   * @deprecated
   */
  public readonly projectType: ProjectType;

  /**
   * Auto approve set up for this project.
   */
  public readonly autoApprove?: AutoApprove;

  constructor(options: GitHubProjectOptions) {
    super(options);

    this.projectType = options.projectType ?? ProjectType.UNKNOWN;
    // we only allow these global services to be used in root projects
    const github = options.github ?? (this.parent ? false : true);
    this.github = github ? new GitHub(this, {
      mergify: options.mergify,
      mergifyOptions: options.mergifyOptions,
      ...options.githubOptions,
    }) : undefined;

    const vscode = options.vscode ?? (this.parent ? false : true);
    this.vscode = vscode ? new VsCode(this) : undefined;

    this.gitpod = options.gitpod ? new Gitpod(this) : undefined;
    this.devContainer = options.devContainer ? new DevContainer(this) : undefined;

    if (options.clobber ?? true) {
      new Clobber(this);
    }

    new SampleReadme(this, options.readme);

    if (options.autoApproveOptions && this.github) {
      this.autoApprove = new AutoApprove(this.github, options.autoApproveOptions);
    }

    const stale = options.stale ?? true;
    if (stale && this.github) {
      new Stale(this.github, options.staleOptions);
    }
  }

  /**
   * Marks the provided file(s) as being generated. This is achieved using the
   * github-linguist attributes. Generated files do not count against the
   * repository statistics and language breakdown.
   *
   * @param glob the glob pattern to match (could be a file path).
   *
   * @see https://github.com/github/linguist/blob/master/docs/overrides.md
   */
  public annotateGenerated(glob: string): void {
    this.gitattributes.addAttributes(glob, 'linguist-generated');
  }
}

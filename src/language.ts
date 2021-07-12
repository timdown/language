import {Tree, SyntaxNode, ChangedRange, TreeFragment, NodeProp, NodeType, Input,
        PartialParse, Parser, ParseSpec, FullParseSpec} from "@lezer/common"
// NOTE: This package should only use _types_ from @lezer/lr, to avoid
// pulling in that dependency when no actual LR parser is used.
import {LRParser, ParserConfig} from "@lezer/lr"
import {Text, TextIterator} from "@codemirror/text"
import {EditorState, StateField, Transaction, Extension, StateEffect, Facet, ChangeDesc} from "@codemirror/state"
import {ViewPlugin, ViewUpdate, EditorView} from "@codemirror/view"

/// Node prop stored in a grammar's top syntax node to provide the
/// facet that stores language data for that language.
export const languageDataProp = new NodeProp<Facet<{[name: string]: any}>>()

/// Helper function to define a facet (to be added to the top syntax
/// node(s) for a language via
/// [`languageDataProp`](#language.languageDataProp)), that will be
/// used to associate language data with the language. You
/// probably only need this when subclassing
/// [`Language`](#language.Language).
export function defineLanguageFacet(baseData?: {[name: string]: any}) {
  return Facet.define<{[name: string]: any}>({
    combine: baseData ? values => values.concat(baseData!) : undefined
  })
}

/// A language object manages parsing and per-language
/// [metadata](#state.EditorState.languageDataAt). Parse data is
/// managed as a [Lezer](https://lezer.codemirror.net) tree. You'll
/// want to subclass this class for custom parsers, or use the
/// [`LezerLanguage`](#language.LezerLanguage) or
/// [`StreamLanguage`](#stream-parser.StreamLanguage) abstractions for
/// [Lezer](https://lezer.codemirror.net/) or stream parsers.
export class Language {
  /// The extension value to install this provider.
  readonly extension: Extension

  /// The parser object. Can be useful when using this as a [nested
  /// parser](https://lezer.codemirror.net/docs/ref#common.Parser).
  parser: Parser

  /// Construct a language object. You usually don't need to invoke
  /// this directly. But when you do, make sure you use
  /// [`defineLanguageFacet`](#language.defineLanguageFacet) to create
  /// the first argument.
  constructor(
    /// The [language data](#state.EditorState.languageDataAt) data
    /// facet used for this language.
    readonly data: Facet<{[name: string]: any}>,
    parser: Parser,
    /// The node type of the top node of trees produced by this parser.
    readonly topNode: NodeType,
    extraExtensions: Extension[] = []
  ) {
    // Kludge to define EditorState.tree as a debugging helper,
    // without the EditorState package actually knowing about
    // languages and lezer trees.
    if (!EditorState.prototype.hasOwnProperty("tree"))
      Object.defineProperty(EditorState.prototype, "tree", {get() { return syntaxTree(this) }})

    this.parser = parser
    this.extension = [
      language.of(this),
      EditorState.languageData.of((state, pos) => state.facet(languageDataFacetAt(state, pos)!))
    ].concat(extraExtensions)
  }

  /// Query whether this language is active at the given position.
  isActiveAt(state: EditorState, pos: number) {
    return languageDataFacetAt(state, pos) == this.data
  }

  /// Find the document regions that were parsed using this language.
  /// The returned regions will _include_ any nested languages rooted
  /// in this language, when those exist.
  findRegions(state: EditorState) {
    let lang = state.facet(language)
    if (lang?.data == this.data) return [{from: 0, to: state.doc.length}]
    if (!lang || !lang.allowsNesting) return []
    let result: {from: number, to: number}[] = []
    syntaxTree(state).iterate({
      enter: (type, from, to) => {
        if (type.isTop && type.prop(languageDataProp) == this.data) {
          result.push({from, to})
          return false
        }
        return undefined
      }
    })
    return result
  }

  /// Indicates whether this language allows nested languages. The
  /// default implementation returns true.
  get allowsNesting() { return true }

  /// @internal
  static state: StateField<LanguageState>

  /// @internal
  static setState = StateEffect.define<LanguageState>()
}

function languageDataFacetAt(state: EditorState, pos: number) {
  let topLang = state.facet(language)
  if (!topLang) return null
  if (!topLang.allowsNesting) return topLang.data
  let tree = syntaxTree(state)
  let target: SyntaxNode | null = tree.resolve(pos, -1)
  while (target) {
    let facet = target.type.prop(languageDataProp)
    if (facet) return facet
    target = target.parent
  }
  return topLang.data
}

/// A subclass of [`Language`](#language.Language) for use with Lezer
/// [LR parsers](https://lezer.codemirror.net/docs/ref#lr.LRParser)
/// parsers.
export class LezerLanguage extends Language {
  private constructor(data: Facet<{[name: string]: any}>,
                      readonly parser: LRParser) {
    super(data, parser, parser.topNode)
  }

  /// Define a language from a parser.
  static define(spec: {
    /// The parser to use. Should already have added editor-relevant
    /// node props (and optionally things like dialect and top rule)
    /// configured.
    parser: LRParser,
    /// [Language data](#state.EditorState.languageDataAt)
    /// to register for this language.
    languageData?: {[name: string]: any}
  }) {
    let data = defineLanguageFacet(spec.languageData)
    return new LezerLanguage(data, spec.parser.configure({
      props: [languageDataProp.add(type => type.isTop ? data : undefined)]
    }))
  }

  /// Create a new instance of this language with a reconfigured
  /// version of its parser.
  configure(options: ParserConfig): LezerLanguage {
    return new LezerLanguage(this.data, this.parser.configure(options))
  }

  get allowsNesting() { return this.parser.hasNested }
}

/// Get the syntax tree for a state, which is the current (possibly
/// incomplete) parse tree of active [language](#language.Language),
/// or the empty tree if there is no language available.
export function syntaxTree(state: EditorState): Tree {
  let field = state.field(Language.state, false)
  return field ? field.tree : Tree.empty
}

/// Try to get a parse tree that spans at least up to `upto`. The
/// method will do at most `timeout` milliseconds of work to parse
/// up to that point if the tree isn't already available.
export function ensureSyntaxTree(state: EditorState, upto: number, timeout = 50): Tree | null {
  let parse = state.field(Language.state, false)?.context
  return !parse ? null : parse.treeLen >= upto || parse.work(timeout, upto) ? parse.tree : null
}

// Lezer-style Input object for a Text document.
class DocInput implements Input {
  cursor: TextIterator
  cursorPos = 0
  string = ""

  constructor(readonly doc: Text, readonly length: number = doc.length) {
    this.cursor = doc.iter()
  }

  private syncTo(pos: number) {
    this.string = this.cursor.next(pos - this.cursorPos).value
    this.cursorPos = pos + this.string.length
    return this.cursorPos - this.string.length
  }

  chunk(pos: number) {
    this.syncTo(pos)
    return this.string
  }

  get lineChunks() { return true }

  read(from: number, to: number) {
    let stringStart = this.cursorPos - this.string.length
    if (from < stringStart || to >= this.cursorPos)
      return this.doc.sliceString(from, to)
    else
      return this.string.slice(from - stringStart, to - stringStart)
  }
}

const enum Work {
  // Milliseconds of work time to perform immediately for a state doc change
  Apply = 25,
  // Minimum amount of work time to perform in an idle callback
  MinSlice = 25,
  // Amount of work time to perform in pseudo-thread when idle callbacks aren't supported
  Slice = 100,
  // Maximum pause (timeout) for the pseudo-thread
  Pause = 500,
  // Parse time budgets are assigned per chunk—the parser can run for
  // ChunkBudget milliseconds at most during ChunkTime milliseconds.
  // After that, no further background parsing is scheduled until the
  // next chunk in which the editor is active.
  ChunkBudget = 3000,
  ChunkTime = 30000,
  // For every change the editor receives while focused, it gets a
  // small bonus to its parsing budget (as a way to allow active
  // editors to continue doing work).
  ChangeBonus = 50,
  // Don't eagerly parse this far beyond the end of the viewport
  MaxParseAhead = 1e6
}

let currentContext: ParseContext | null = null

/// A parse context provided to parsers working on the editor content.
export class ParseContext {
  private parse: PartialParse | null = null
  /// @internal
  tempSkipped: {from: number, to: number}[] = []

  /// @internal
  constructor(
    private parser: Parser,
    /// The current editor state.
    readonly state: EditorState,
    /// Tree fragments that can be reused by incremental re-parses.
    public fragments: readonly TreeFragment[] = [],
    /// @internal
    public tree: Tree,
    public treeLen: number,
    /// The current editor viewport (or some overapproximation
    /// thereof). Intended to be used for opportunistically avoiding
    /// work (in which case
    /// [`skipUntilInView`](#language.EditorParseContext.skipUntilInView)
    /// should be called to make sure the parser is restarted when the
    /// skipped region becomes visible).
    public viewport: {from: number, to: number},
    /// @internal
    public skipped: {from: number, to: number}[],
    /// This is where skipping parsers can register a promise that,
    /// when resolved, will schedule a new parse. It is cleared when
    /// the parse worker picks up the promise. @internal
    public scheduleOn: Promise<unknown> | null
  ) {}

  private startParse() {
    return this.parser.startParse({input: new DocInput(this.state.doc), fragments: this.fragments})
  }

  /// @internal
  work(time: number, upto?: number) {
    if (this.tree != Tree.empty && (upto == null ? this.treeLen == this.state.doc.length : this.treeLen >= upto)) {
      this.takeTree()
      return true
    }
    return this.withContext(() => {
      if (!this.parse) this.parse = this.startParse()
      if (upto != null && (this.parse.stoppedAt == null || this.parse.stoppedAt > upto) &&
          upto < this.state.doc.length) this.parse.stopAt(upto)
      let endTime = Date.now() + time
      for (;;) {
        let done = this.parse.advance()
        if (done) {
          this.fragments = this.withoutTempSkipped(TreeFragment.addTree(done, this.fragments, this.parse.stoppedAt != null))
          this.treeLen = this.parse.stoppedAt ?? this.state.doc.length
          this.tree = done
          this.parse = null
          if (this.treeLen < (upto ?? this.state.doc.length))
            this.parse = this.startParse()
          else
            return true
        }
        if (Date.now() > endTime) return false
      }
    })
  }
  
  /// @internal
  takeTree() {
    let pos, tree: Tree | undefined | null
    if (this.parse && (pos = this.parse.parsedPos) > this.treeLen) {
      if (this.parse.stoppedAt == null || this.parse.stoppedAt > pos) this.parse.stopAt(pos)
      this.withContext(() => { while (!(tree = this.parse!.advance())) {} })
      this.tree = tree!
      this.fragments = this.withoutTempSkipped(TreeFragment.addTree(this.tree, this.fragments, true))
      this.parse = null
    }
  }

  private withContext<T>(f: () => T): T {
    let prev = currentContext
    currentContext = this
    try { return f() }
    finally { currentContext = prev }
  }

  private withoutTempSkipped(fragments: readonly TreeFragment[]) {
    for (let r; r = this.tempSkipped.pop();)
      fragments = cutFragments(fragments, r.from, r.to)
    return fragments
  }

  /// @internal
  changes(changes: ChangeDesc, newState: EditorState) {
    let {fragments, tree, treeLen, viewport, skipped} = this
    this.takeTree()
    if (!changes.empty) {
      let ranges: ChangedRange[] = []
      changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({fromA, toA, fromB, toB}))
      fragments = TreeFragment.applyChanges(fragments, ranges)
      tree = Tree.empty
      treeLen = 0
      viewport = {from: changes.mapPos(viewport.from, -1), to: changes.mapPos(viewport.to, 1)}
      if (this.skipped.length) {
        skipped = []
        for (let r of this.skipped) {
          let from = changes.mapPos(r.from, 1), to = changes.mapPos(r.to, -1)
          if (from < to) skipped.push({from, to})
        }
      }
    }
    return new ParseContext(this.parser, newState, fragments, tree, treeLen, viewport, skipped, this.scheduleOn)
  }

  /// @internal
  updateViewport(viewport: {from: number, to: number}) {
    this.viewport = viewport
    let startLen = this.skipped.length
    for (let i = 0; i < this.skipped.length; i++) {
      let {from, to} = this.skipped[i]
      if (from < viewport.to && to > viewport.from) {
        this.fragments = cutFragments(this.fragments, from, to)
        this.skipped.splice(i--, 1)
      }
    }
    return this.skipped.length < startLen
  }

  /// @internal
  reset() {
    if (this.parse) {
      this.takeTree()
      this.parse = null
    }
  }

  /// Notify the parse scheduler that the given region was skipped
  /// because it wasn't in view, and the parse should be restarted
  /// when it comes into view.
  skipUntilInView(from: number, to: number) {
    this.skipped.push({from, to})
  }

  /// Returns a parser intended to be used as placeholder when
  /// asynchronously loading a nested parser. It'll skip its input and
  /// mark it as not-really-parsed, so that the next update will parse
  /// it again.
  ///
  /// When `until` is given, a reparse will be scheduled when that
  /// promise resolves.
  static getSkippingParser(until?: Promise<unknown>) {
    return new class extends Parser {
      startParse(spec: ParseSpec): PartialParse {
        let {from, to} = new FullParseSpec(spec)
        let parser = {
          parsedPos: from,
          advance() {
            let cx = currentContext
            if (cx) {
              cx.tempSkipped.push({from, to})
              if (until) cx.scheduleOn = cx.scheduleOn ? Promise.all([cx.scheduleOn, until]) : until
            }
            this.parsedPos = to
            return new Tree(NodeType.none, [], [], to - from)
          },
          stoppedAt: null,
          stopAt() {}
        }
        return parser
      }
    }
  }

  /// @internal
  movedPast(pos: number) {
    return this.treeLen < pos && this.parse && this.parse.parsedPos >= pos
  }

  /// Get the context for the current parse, or `null` if no editor
  /// parse is in progress.
  static get() { return currentContext }
}

function cutFragments(fragments: readonly TreeFragment[], from: number, to: number) {
  return TreeFragment.applyChanges(fragments, [{fromA: from, toA: to, fromB: from, toB: to}])
}

class LanguageState {
  // The current tree. Immutable, because directly accessible from
  // the editor state.
  readonly tree: Tree

  constructor(
    // A mutable parse state that is used to preserve work done during
    // the lifetime of a state when moving to the next state.
    readonly context: ParseContext
  ) {
    this.tree = context.tree
  }

  apply(tr: Transaction) {
    if (!tr.docChanged) return this
    let newCx = this.context.changes(tr.changes, tr.state)
    // If the previous parse wasn't done, go forward only up to its
    // end position or the end of the viewport, to avoid slowing down
    // state updates with parse work beyond the viewport.
    let upto = this.context.treeLen == tr.startState.doc.length ? undefined
      : Math.max(tr.changes.mapPos(this.context.treeLen), newCx.viewport.to)
    if (!newCx.work(Work.Apply, upto)) newCx.takeTree()
    return new LanguageState(newCx)
  }

  static init(state: EditorState) {
    let parseState = new ParseContext(state.facet(language)!.parser, state, [],
                                      Tree.empty, 0, {from: 0, to: state.doc.length}, [], null)
    if (!parseState.work(Work.Apply)) parseState.takeTree()
    return new LanguageState(parseState)
  }
}

Language.state = StateField.define<LanguageState>({
  create: LanguageState.init,
  update(value, tr) {
    for (let e of tr.effects) if (e.is(Language.setState)) return e.value
    if (tr.startState.facet(language) != tr.state.facet(language)) return LanguageState.init(tr.state)
    return value.apply(tr)
  }
})

type Deadline = {timeRemaining(): number, didTimeout: boolean}
type IdleCallback = (deadline?: Deadline) => void

let requestIdle: (callback: IdleCallback, options: {timeout: number}) => number =
  typeof window != "undefined" && (window as any).requestIdleCallback ||
  ((callback: IdleCallback, {timeout}: {timeout: number}) => setTimeout(callback, timeout))
let cancelIdle: (id: number) => void = typeof window != "undefined" && (window as any).cancelIdleCallback || clearTimeout

const parseWorker = ViewPlugin.fromClass(class ParseWorker {
  working: number = -1
  // End of the current time chunk
  chunkEnd = -1
  // Milliseconds of budget left for this chunk
  chunkBudget = -1

  constructor(readonly view: EditorView) {
    this.work = this.work.bind(this)
    this.scheduleWork()
  }

  update(update: ViewUpdate) {
    let cx = this.view.state.field(Language.state).context
    if (update.viewportChanged) {
      if (cx.updateViewport(update.view.viewport)) cx.reset()
      if (this.view.viewport.to > cx.treeLen) this.scheduleWork()
    }
    if (update.docChanged) {
      if (this.view.hasFocus) this.chunkBudget += Work.ChangeBonus
      this.scheduleWork()
    }
    this.checkAsyncSchedule(cx)
  }

  scheduleWork() {
    if (this.working > -1) return
    let {state} = this.view, field = state.field(Language.state), frags = field.context.fragments
    if (field.tree == field.context.tree && field.context.treeLen >= state.doc.length &&
        frags.length && frags[0].from == 0 && frags[0].to >= state.doc.length) return
    this.working = requestIdle(this.work, {timeout: Work.Pause})
  }

  work(deadline?: Deadline) {
    this.working = -1

    let now = Date.now()
    if (this.chunkEnd < now && (this.chunkEnd < 0 || this.view.hasFocus)) { // Start a new chunk
      this.chunkEnd = now + Work.ChunkTime
      this.chunkBudget = Work.ChunkBudget
    }
    if (this.chunkBudget <= 0) return // No more budget

    let {state, viewport: {to: vpTo}} = this.view, field = state.field(Language.state)
    if (field.tree == field.context.tree && field.context.treeLen >= vpTo + Work.MaxParseAhead) return
    let time = Math.min(this.chunkBudget, deadline ? Math.max(Work.MinSlice, deadline.timeRemaining()) : Work.Slice)
    let done = field.context.work(time, vpTo + Work.MaxParseAhead)
    this.chunkBudget -= Date.now() - now
    if (done || this.chunkBudget <= 0 || field.context.movedPast(vpTo)) {
      field.context.takeTree()
      this.view.dispatch({effects: Language.setState.of(new LanguageState(field.context))})
    }
    if (!done && this.chunkBudget > 0) this.scheduleWork()
    this.checkAsyncSchedule(field.context)
  }

  checkAsyncSchedule(cx: ParseContext) {
    if (cx.scheduleOn) {
      cx.scheduleOn.then(() => this.scheduleWork())
      cx.scheduleOn = null
    }
  }

  destroy() {
    if (this.working >= 0) cancelIdle(this.working)
  }
}, {
  eventHandlers: {focus() { this.scheduleWork() }}
})

/// The facet used to associate a language with an editor state.
export const language = Facet.define<Language, Language | null>({
  combine(languages) { return languages.length ? languages[0] : null },
  enables: [Language.state, parseWorker]
})

/// This class bundles a [language object](#language.Language) with an
/// optional set of supporting extensions. Language packages are
/// encouraged to export a function that optionally takes a
/// configuration object and returns a `LanguageSupport` instance, as
/// the main way for client code to use the package.
export class LanguageSupport {
  /// An extension including both the language and its support
  /// extensions. (Allowing the object to be used as an extension
  /// value itself.)
  extension: Extension

  /// Create a support object.
  constructor(
    /// The language object.
    readonly language: Language,
    /// An optional set of supporting extensions. When nesting a
    /// language in another language, the outer language is encouraged
    /// to include the supporting extensions for its inner languages
    /// in its own set of support extensions.
    readonly support: Extension = []
  ) {
    this.extension = [language, support]
  }
}

/// Language descriptions are used to store metadata about languages
/// and to dynamically load them. Their main role is finding the
/// appropriate language for a filename or dynamically loading nested
/// parsers.
export class LanguageDescription {
  /// If the language has been loaded, this will hold its value.
  support: LanguageSupport | undefined = undefined

  private loading: Promise<LanguageSupport> | null = null

  private constructor(
    /// The name of this language.
    readonly name: string,
    /// Alternative names for the mode (lowercased, includes `this.name`).
    readonly alias: readonly string[],
    /// File extensions associated with this language.
    readonly extensions: readonly string[],
    /// Optional filename pattern that should be associated with this
    /// language.
    readonly filename: RegExp | undefined,
    private loadFunc: () => Promise<LanguageSupport>
  ) {}

  /// Start loading the the language. Will return a promise that
  /// resolves to a [`LanguageSupport`](#language.LanguageSupport)
  /// object when the language successfully loads.
  load(): Promise<LanguageSupport> {
    return this.loading || (this.loading = this.loadFunc().then(
      support => this.support = support,
      err => { this.loading = null; throw err }
    ))
  }

  /// Create a language description.
  static of(spec: {
    /// The language's name.
    name: string,
    /// An optional array of alternative names.
    alias?: readonly string[],
    /// An optional array of extensions associated with this language.
    extensions?: readonly string[],
    /// An optional filename pattern associated with this language.
    filename?: RegExp,
    /// A function that will asynchronously load the language.
    load: () => Promise<LanguageSupport>
  }) {
    return new LanguageDescription(spec.name, (spec.alias || []).concat(spec.name).map(s => s.toLowerCase()),
                                   spec.extensions || [], spec.filename, spec.load)
  }

  /// Look for a language in the given array of descriptions that
  /// matches the filename. Will first match
  /// [`filename`](#language.LanguageDescription.filename) patterns,
  /// and then [extensions](#language.LanguageDescription.extensions),
  /// and return the first language that matches.
  static matchFilename(descs: readonly LanguageDescription[], filename: string) {
    for (let d of descs) if (d.filename && d.filename.test(filename)) return d
    let ext = /\.([^.]+)$/.exec(filename)
    if (ext) for (let d of descs) if (d.extensions.indexOf(ext[1]) > -1) return d
    return null
  }

  /// Look for a language whose name or alias matches the the given
  /// name (case-insensitively). If `fuzzy` is true, and no direct
  /// matchs is found, this'll also search for a language whose name
  /// or alias occurs in the string (for names shorter than three
  /// characters, only when surrounded by non-word characters).
  static matchLanguageName(descs: readonly LanguageDescription[], name: string, fuzzy = true) {
    name = name.toLowerCase()
    for (let d of descs) if (d.alias.some(a => a == name)) return d
    if (fuzzy) for (let d of descs) for (let a of d.alias) {
      let found = name.indexOf(a)
      if (found > -1 && (a.length > 2 || !/\w/.test(name[found - 1]) && !/\w/.test(name[found + a.length])))
        return d
    }
    return null
  }
}

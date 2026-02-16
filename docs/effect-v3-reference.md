# Effect v3 API Reference for NanoClaw Runtime v2

> Comprehensive reference for the Effect patterns used in the NanoClaw Effect Runtime rewrite.
> All examples use the latest Effect v3 API (effect ^3.x, @effect/platform-bun, @effect/schema).

---

## Table of Contents

1. [Context.Tag Service Pattern](#1-contexttag-service-pattern)
2. [Layer Composition](#2-layer-composition)
3. [Effect.try vs Effect.sync](#3-effecttry-vs-effectsync)
4. [Effect.scoped + Effect.addFinalizer](#4-effectscoped--effectaddfinalizer)
5. [SynchronizedRef](#5-synchronizedref)
6. [Fiber Supervision & Interrupt Detection](#6-fiber-supervision--interrupt-detection)
7. [Queue](#7-queue)
8. [Stream.async and Stream.asyncScoped](#8-streamasync-and-streamasyncscoped)
9. [Effect Schema](#9-effect-schema)
10. [BunRuntime.runMain](#10-bunruntimerunmain)

---

## 1. Context.Tag Service Pattern

Services in Effect are defined with `Context.Tag`, which creates a unique identifier for dependency injection. The tag is both a type-level marker and a runtime key.

### Defining a Service

```typescript
import { Context, Effect, Layer } from "effect"

// Define the service interface + tag in one declaration
class Database extends Context.Tag("Database")<
  Database,
  {
    readonly query: (sql: string) => Effect.Effect<Array<unknown>>
    readonly execute: (sql: string, params: unknown[]) => Effect.Effect<void>
  }
>() {}
```

The generic parameters are:
- First: the class itself (self-reference for type inference)
- Second: the service interface shape

### Accessing a Service

```typescript
const program = Effect.gen(function* () {
  const db = yield* Database  // yields the service from context
  const rows = yield* db.query("SELECT * FROM users")
  return rows
})
// Type: Effect<Array<unknown>, never, Database>
//                                      ^^^^^^^^ requires Database in context
```

### Providing a Service via Layer

There are three primary Layer constructors for providing services:

#### `Layer.succeed` -- Static value, no effects needed

```typescript
const DatabaseLive = Layer.succeed(
  Database,
  {
    query: (sql) => Effect.succeed([]),
    execute: (sql, params) => Effect.void
  }
)
// Type: Layer<Database, never, never>
```

#### `Layer.effect` -- Effectful construction (may fail, may need dependencies)

```typescript
const DatabaseLive = Layer.effect(
  Database,
  Effect.gen(function* () {
    const config = yield* Config       // pull another service
    const pool = yield* createPool(config.connectionString)
    return {
      query: (sql) => Effect.tryPromise(() => pool.query(sql)),
      execute: (sql, params) => Effect.tryPromise(() => pool.execute(sql, params))
    }
  })
)
// Type: Layer<Database, ConnectionError, Config>
```

#### `Layer.scoped` -- Effectful construction with resource lifecycle

Use when the service acquires resources that must be released (connections, file handles, subscriptions).

```typescript
const DatabaseLive = Layer.scoped(
  Database,
  Effect.gen(function* () {
    const config = yield* Config
    const pool = yield* Effect.acquireRelease(
      createPool(config.connectionString),           // acquire
      (pool) => Effect.sync(() => pool.destroy())    // release (runs on scope close)
    )
    yield* Effect.addFinalizer(() =>
      Effect.log("Database pool shutting down")
    )
    return {
      query: (sql) => Effect.tryPromise(() => pool.query(sql)),
      execute: (sql, params) => Effect.tryPromise(() => pool.execute(sql, params))
    }
  })
)
// Type: Layer<Database, ConnectionError, Config>
// The Scope requirement is automatically handled by Layer.scoped
```

**When to use which:**

| Constructor     | Use when                                    | Scope handled? |
| --------------- | ------------------------------------------- | -------------- |
| `Layer.succeed` | Service is a plain value, no effects needed | N/A            |
| `Layer.effect`  | Service needs effectful setup (API calls, reads) but no cleanup | N/A |
| `Layer.scoped`  | Service acquires resources that need cleanup | Yes, automatically |

---

## 2. Layer Composition

### `Layer.merge` -- Combine two layers in parallel

Merges two layers concurrently. The resulting layer provides the union of both outputs and requires the union of both inputs.

```typescript
// Layer.merge(A, B) => provides A | B, requires inputs of A | inputs of B
const AppConfigLive = Layer.merge(ConfigLive, LoggerLive)
// Type: Layer<Config | Logger, never, never>
```

### `Layer.mergeAll` -- Combine multiple layers in parallel

Same as `merge` but for variadic number of layers.

```typescript
const AppLayer = Layer.mergeAll(ConfigLive, LoggerLive, MetricsLive, TracingLive)
// Type: Layer<Config | Logger | Metrics | Tracing, never, never>
```

### `Layer.provide` -- Feed outputs into inputs

Feeds the output of one layer into the requirements of another, resolving dependencies.

```typescript
// DatabaseLive requires Config + Logger
// AppConfigLive provides Config + Logger
const DatabaseResolved = DatabaseLive.pipe(
  Layer.provide(AppConfigLive)
)
// Type: Layer<Database, never, never>  -- all deps resolved
```

### `Layer.provideMerge` -- Provide AND keep the provider's outputs

Like `Layer.provide`, but the resulting layer outputs BOTH the consumer's services AND the provider's services.

```typescript
const MainLive = DatabaseLive.pipe(
  Layer.provide(AppConfigLive),        // resolve Database's deps
  Layer.provideMerge(AppConfigLive)    // also export Config + Logger
)
// Type: Layer<Config | Logger | Database, never, never>
```

### When to use `provideMerge` vs `mergeAll`

- **`Layer.mergeAll(A, B, C)`**: Use when layers are independent (no deps between them). Simply bundles them together.
- **`Layer.provideMerge(provider)(consumer)`**: Use when the consumer depends on the provider, AND you want downstream layers to also access the provider's services.

### Full composition example (NanoClaw pattern)

```typescript
// Independent base services
const BaseLive = Layer.mergeAll(ConfigLive, LoggerLive)

// Database depends on Config + Logger
const WithDatabase = DatabaseLive.pipe(
  Layer.provide(BaseLive),
  Layer.provideMerge(BaseLive)   // keep Config + Logger available
)
// Type: Layer<Config | Logger | Database, never, never>

// Telegram depends on Config
const WithTelegram = TelegramLive.pipe(
  Layer.provide(WithDatabase)
)

// Final app layer
const AppLive = Layer.mergeAll(WithDatabase, WithTelegram)
```

### Layer Memoization

Layers are memoized by default. If the same layer appears multiple times in a composition graph, it is only built once. This is critical for shared resources like database pools.

---

## 3. Effect.try vs Effect.sync

### `Effect.sync` -- Trusted synchronous side effects

Wraps a synchronous function that is **guaranteed not to throw**. If it does throw, the exception becomes a **defect** (untracked, crashes the fiber).

```typescript
import { Effect } from "effect"

// Safe: console.log never throws
const log = (message: string) =>
  Effect.sync(() => {
    console.log(message)
  })
// Type: Effect<void, never, never>
//                   ^^^^^ no error channel

// Safe: Map.get never throws
const getFromMap = (map: Map<string, number>, key: string) =>
  Effect.sync(() => map.get(key))
// Type: Effect<number | undefined, never, never>
```

### `Effect.try` -- Synchronous operations that might throw

Wraps a synchronous function that **might throw**. Catches the exception and puts it in the error channel as a tracked error.

```typescript
// Without custom error mapping (error becomes UnknownException)
const parseJson = (input: string) =>
  Effect.try(() => JSON.parse(input))
// Type: Effect<unknown, UnknownException, never>

// With custom error mapping (recommended)
class JsonParseError {
  readonly _tag = "JsonParseError"
  constructor(readonly input: string, readonly cause: unknown) {}
}

const parseJson = (input: string) =>
  Effect.try({
    try: () => JSON.parse(input) as Record<string, unknown>,
    catch: (error) => new JsonParseError(input, error)
  })
// Type: Effect<Record<string, unknown>, JsonParseError, never>
```

### `Effect.tryPromise` -- Async operations that might reject

```typescript
const fetchData = (url: string) =>
  Effect.tryPromise({
    try: () => fetch(url).then((r) => r.json()),
    catch: (error) => new FetchError(url, error)
  })
// Type: Effect<unknown, FetchError, never>
```

### Decision table

| Scenario                                | Use               | Error channel           |
| --------------------------------------- | ----------------- | ----------------------- |
| `console.log()`, `Map.set()`           | `Effect.sync`     | `never` (defect if throws) |
| `JSON.parse()`, `new URL()`            | `Effect.try`      | `UnknownException` or custom |
| `fetch()`, any Promise                  | `Effect.tryPromise` | `UnknownException` or custom |
| Value already known                     | `Effect.succeed`  | `never`                 |
| Known error                             | `Effect.fail`     | custom error type       |

---

## 4. Effect.scoped + Effect.addFinalizer

Scopes manage the lifetime of resources. Finalizers are cleanup functions that execute when a scope closes, regardless of success/failure/interruption.

### Basic Pattern

```typescript
import { Console, Effect } from "effect"

const program = Effect.gen(function* () {
  // Register a finalizer -- runs when scope closes
  yield* Effect.addFinalizer((exit) =>
    Console.log(`Finalizer: exit was ${exit._tag}`)
  )

  // Do work...
  return "result"
})

// Effect.scoped converts Effect<A, E, Scope> => Effect<A, E, never>
const runnable = Effect.scoped(program)
```

### Finalizer receives Exit

The `exit` parameter tells you how the scope ended:

```typescript
yield* Effect.addFinalizer((exit) => {
  if (exit._tag === "Success") {
    return Effect.log("Clean shutdown")
  }
  if (exit._tag === "Failure") {
    const cause = exit.cause
    if (Cause.isInterruptedOnly(cause)) {
      return Effect.log("Interrupted -- cleaning up")
    }
    return Effect.log(`Failed: ${Cause.pretty(cause)}`)
  }
  return Effect.void
})
```

### Execution Order

Finalizers run in **reverse order** (LIFO). Last registered = first to run.

```typescript
const program = Effect.gen(function* () {
  yield* Effect.addFinalizer(() => Console.log("finalizer 1"))  // runs second
  yield* Effect.addFinalizer(() => Console.log("finalizer 2"))  // runs first
  return "done"
})
// Output on scope close:
// finalizer 2
// finalizer 1
```

### acquireRelease Pattern

For resources that need paired acquire/release:

```typescript
const managedConnection = Effect.acquireRelease(
  // Acquire: create the resource
  Effect.tryPromise(() => createConnection(url)),
  // Release: clean up (always runs)
  (conn) => Effect.sync(() => conn.close())
)
// Type: Effect<Connection, ConnectionError, Scope>
```

### Layer.scoped ties it together

When you use `Layer.scoped`, the layer's scope is tied to the application lifecycle. Finalizers run when the layer is torn down (app shutdown).

```typescript
const TelegramLive = Layer.scoped(
  TelegramService,
  Effect.gen(function* () {
    const bot = new Bot(yield* (yield* Config).telegramToken)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => bot.stop())
    )
    yield* Effect.tryPromise(() => bot.init())
    return { bot }
  })
)
```

---

## 5. SynchronizedRef

`SynchronizedRef<A>` is a concurrent-safe mutable reference that supports **effectful** atomic updates. Unlike `Ref` (which only allows pure updates), `SynchronizedRef` lets you run effects during the update.

### Creating

```typescript
import { Effect, SynchronizedRef } from "effect"

const ref = yield* SynchronizedRef.make<Map<string, number>>(new Map())
```

### Reading

```typescript
const current = yield* SynchronizedRef.get(ref)
```

### Effectful Update

`updateEffect` atomically modifies the value using an effectful function. Only one fiber can update at a time -- other fibers' updates are queued.

```typescript
yield* SynchronizedRef.updateEffect(ref, (currentMap) =>
  Effect.gen(function* () {
    // Can do effectful work here (API calls, DB queries, etc.)
    const freshData = yield* fetchLatestData()
    const newMap = new Map(currentMap)
    newMap.set("key", freshData.value)
    return newMap
  })
)
```

### Effectful Modify (return a value + update)

`modifyEffect` atomically updates the ref AND returns a derived value in one operation.

```typescript
const removed = yield* SynchronizedRef.modifyEffect(ref, (currentMap) =>
  Effect.gen(function* () {
    const value = currentMap.get("key")
    const newMap = new Map(currentMap)
    newMap.delete("key")
    return [value, newMap] as const  // [returnValue, newState]
  })
)
// removed: number | undefined
```

### When to use SynchronizedRef vs Ref

| Feature           | `Ref`                     | `SynchronizedRef`                |
| ----------------- | ------------------------- | -------------------------------- |
| Update function   | Pure: `(A) => A`          | Effectful: `(A) => Effect<A>`   |
| Concurrency       | Lock-free, atomic         | Sequential (queued)              |
| Use case          | Simple counters, flags    | State that needs I/O during update |
| Performance       | Higher (no queue)         | Lower (serialized)              |

### NanoClaw Pattern: Concurrent State Registry

```typescript
// Track active container runs per group
const activeRuns = yield* SynchronizedRef.make<Map<string, Fiber.RuntimeFiber<void>>>(new Map())

// Register a new run (effectful -- needs to fork a fiber)
yield* SynchronizedRef.updateEffect(activeRuns, (runs) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(runContainer(groupId, input))
    const newRuns = new Map(runs)
    newRuns.set(groupId, fiber)
    return newRuns
  })
)

// Cancel and remove a run
yield* SynchronizedRef.modifyEffect(activeRuns, (runs) =>
  Effect.gen(function* () {
    const fiber = runs.get(groupId)
    if (fiber) {
      yield* Fiber.interrupt(fiber)
    }
    const newRuns = new Map(runs)
    newRuns.delete(groupId)
    return [fiber !== undefined, newRuns] as const
  })
)
```

---

## 6. Fiber Supervision & Interrupt Detection

### Interrupting a Fiber

```typescript
import { Effect, Fiber } from "effect"

const program = Effect.gen(function* () {
  const fiber = yield* Effect.fork(longRunningTask)
  // ... later ...
  yield* Fiber.interrupt(fiber)
})
```

### Detecting Interrupts vs Errors with catchAllCause

`Effect.catchAllCause` catches ALL failure causes, including interrupts and defects (not just tagged errors). This is how you distinguish between intentional interruption and real errors.

```typescript
import { Effect, Cause } from "effect"

const resilientTask = myEffect.pipe(
  Effect.catchAllCause((cause) => {
    if (Cause.isInterruptedOnly(cause)) {
      // ONLY interruption, no other errors
      return Effect.log("Task was cancelled, cleaning up")
    }
    // Real error (Fail, Die, or composite)
    return Effect.log(`Real failure: ${Cause.pretty(cause)}`)
  })
)
```

### Cause Guard Functions

| Guard                       | Returns true when                                           |
| --------------------------- | ----------------------------------------------------------- |
| `Cause.isInterruptedOnly`   | Cause contains ONLY interrupts (no Fail, no Die)           |
| `Cause.isInterruptType`     | Cause node is specifically an Interrupt (may be nested)     |
| `Cause.isFailType`          | Cause node is specifically a Fail (expected error)          |
| `Cause.isDie`               | Cause node is specifically a Die (defect)                   |
| `Cause.isEmpty`             | Cause is empty (no error)                                   |

### Pattern Matching on Cause

```typescript
const result = Cause.match(cause, {
  onEmpty: "no error",
  onFail: (error) => `expected error: ${error._tag}`,
  onDie: (defect) => `defect: ${defect}`,
  onInterrupt: (fiberId) => `interrupted by fiber ${fiberId}`,
  onSequential: (left, right) => `${left} then ${right}`,
  onParallel: (left, right) => `${left} and ${right}`
})
```

### Effect.onInterrupt -- Register Cleanup on Interrupt

```typescript
const task = Effect.gen(function* () {
  yield* doWork()
}).pipe(
  Effect.onInterrupt(() =>
    Effect.log("This fiber was interrupted, running cleanup")
  )
)
```

### NanoClaw Pattern: Graceful Container Shutdown

```typescript
const runContainer = (groupId: string, input: ContainerInput) =>
  Effect.gen(function* () {
    const result = yield* spawnDocker(groupId, input)
    return result
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.gen(function* () {
        yield* Effect.log(`Container for ${groupId} interrupted`)
        yield* cleanupIpcFiles(groupId)
      })
    ),
    Effect.catchAllCause((cause) => {
      if (Cause.isInterruptedOnly(cause)) {
        return Effect.succeed({ interrupted: true })
      }
      return Effect.fail(new ContainerError(groupId, cause))
    })
  )
```

---

## 7. Queue

Effect Queues are concurrent, back-pressured data structures for inter-fiber communication.

### Creating Queues

```typescript
import { Effect, Queue } from "effect"

// Unbounded: never blocks on offer
const queue = yield* Queue.unbounded<Message>()

// Bounded: blocks offer when full (back-pressure)
const bounded = yield* Queue.bounded<Message>(100)

// Dropping: silently drops new items when full
const dropping = yield* Queue.dropping<Message>(100)

// Sliding: drops oldest items when full
const sliding = yield* Queue.sliding<Message>(100)
```

### Basic Operations

```typescript
// Add to queue (suspends if bounded & full)
yield* Queue.offer(queue, message)

// Add multiple
yield* Queue.offerAll(queue, [msg1, msg2, msg3])

// Take (suspends until available)
const msg = yield* Queue.take(queue)

// Poll (non-blocking, returns Option)
const maybe = yield* Queue.poll(queue)

// Take up to N (non-blocking)
const batch = yield* Queue.takeUpTo(queue, 10)

// Take exactly N (suspends until N available)
const exactBatch = yield* Queue.takeN(queue, 5)

// Take all available (non-blocking)
const all = yield* Queue.takeAll(queue)

// Shutdown
yield* Queue.shutdown(queue)
```

### Typed Interfaces: Enqueue and Dequeue

Queues can be narrowed to offer-only or take-only for type safety:

```typescript
const producer = (q: Queue.Enqueue<Message>) =>
  Queue.offer(q, { text: "hello" })

const consumer = (q: Queue.Dequeue<Message>) =>
  Queue.take(q)

// Full queue satisfies both interfaces
const queue = yield* Queue.unbounded<Message>()
yield* producer(queue)   // works
yield* consumer(queue)   // works
```

### Stream.fromQueue -- Convert Queue to Stream

```typescript
import { Stream, Queue, Effect } from "effect"

const messageStream = Effect.gen(function* () {
  const queue = yield* Queue.unbounded<Message>()

  // Create a stream that consumes from the queue
  const stream = Stream.fromQueue(queue, {
    maxChunkSize: 1,     // emit items one at a time
    shutdown: false       // don't shut down queue when stream ends
  })

  return { queue, stream }
})
```

### NanoClaw Pattern: Message Routing via Queue

```typescript
// Per-group message queues for routing
const createRouter = Effect.gen(function* () {
  const queues = yield* SynchronizedRef.make<Map<string, Queue.Queue<TelegramMessage>>>(
    new Map()
  )

  const getOrCreateQueue = (groupId: string) =>
    SynchronizedRef.modifyEffect(queues, (map) =>
      Effect.gen(function* () {
        const existing = map.get(groupId)
        if (existing) return [existing, map] as const
        const q = yield* Queue.unbounded<TelegramMessage>()
        const newMap = new Map(map)
        newMap.set(groupId, q)
        return [q, newMap] as const
      })
    )

  const route = (groupId: string, msg: TelegramMessage) =>
    Effect.gen(function* () {
      const queue = yield* getOrCreateQueue(groupId)
      yield* Queue.offer(queue, msg)
    })

  return { route, getOrCreateQueue }
})
```

---

## 8. Stream.async and Stream.asyncScoped

### Stream.async -- Wrap callback-based APIs

Creates a stream from a callback that may be invoked multiple times. Each invocation can emit values, signal errors, or end the stream.

```typescript
import { Stream, Chunk, Effect, Option } from "effect"

const fromEventSource = (url: string) =>
  Stream.async<string, Error>((emit) => {
    const source = new EventSource(url)

    source.onmessage = (event) => {
      // Emit a value
      emit(Effect.succeed(Chunk.of(event.data)))
    }

    source.onerror = (err) => {
      // Signal error and end stream
      emit(Effect.fail(Option.some(new Error("SSE failed"))))
    }

    // Return cleanup effect (runs on stream interrupt/end)
    return Effect.sync(() => {
      source.close()
    })
  })
```

### Emit Protocol

The `emit` callback accepts `Effect<Chunk<A>, Option<E>, R>`:

| Call                                      | Meaning                     |
| ----------------------------------------- | --------------------------- |
| `emit(Effect.succeed(Chunk.of(value)))`   | Emit one value              |
| `emit(Effect.succeed(Chunk.make(a, b)))` | Emit multiple values        |
| `emit(Effect.fail(Option.none()))`        | End stream (no error)       |
| `emit(Effect.fail(Option.some(error)))`   | End stream with error       |

### Buffer Options

```typescript
Stream.async<A, E>((emit) => { ... }, {
  bufferSize: 16,
  strategy: "sliding"  // "dropping" | "sliding" | "suspend"
})

// Or unbounded
Stream.async<A, E>((emit) => { ... }, "unbounded")
```

### Stream.asyncScoped -- Callback with scoped resources

Like `Stream.async`, but the registration function returns a **scoped** effect, meaning it can use `Effect.addFinalizer` and other scoped resource management.

```typescript
import { Stream, Chunk, Effect, Option, Scope } from "effect"

const fromGrammyBot = (bot: Bot) =>
  Stream.asyncScoped<Message, BotError>((emit) =>
    Effect.gen(function* () {
      // Register event handler
      bot.on("message:text", (ctx) => {
        emit(Effect.succeed(Chunk.of(ctx.message)))
      })

      // Start the bot (scoped resource)
      yield* Effect.acquireRelease(
        Effect.tryPromise(() => bot.start()),
        () => Effect.sync(() => bot.stop())
      )

      // Additional scoped finalizer
      yield* Effect.addFinalizer(() =>
        Effect.log("Bot stream shutting down")
      )
    })
  )
// Type: Stream<Message, BotError, never>
// (Scope requirement is automatically handled)
```

### When to use asyncScoped vs async

| Feature                   | `Stream.async`                      | `Stream.asyncScoped`                      |
| ------------------------- | ----------------------------------- | ----------------------------------------- |
| Registration returns      | `Effect<void>` or cleanup effect    | `Effect<unknown, E, R \| Scope>`          |
| Resource management       | Manual (return cleanup effect)      | Automatic via Scope                       |
| Multiple finalizers       | No                                  | Yes (addFinalizer, acquireRelease)        |
| Use case                  | Simple callbacks (timers, events)   | Complex resources (bot connections, subscriptions) |

### NanoClaw Pattern: Telegram Bot Event Stream

```typescript
const telegramStream = (bot: Bot) =>
  Stream.asyncScoped<TelegramUpdate, TelegramError>((emit) =>
    Effect.gen(function* () {
      // Handle text messages
      bot.on("message:text", (ctx) => {
        emit(Effect.succeed(Chunk.of({
          type: "text" as const,
          chatId: ctx.chat.id,
          text: ctx.message.text,
          from: ctx.from
        })))
      })

      // Handle voice messages
      bot.on("message:voice", (ctx) => {
        emit(Effect.succeed(Chunk.of({
          type: "voice" as const,
          chatId: ctx.chat.id,
          fileId: ctx.message.voice.file_id,
          from: ctx.from
        })))
      })

      // Start polling with scoped cleanup
      yield* Effect.acquireRelease(
        Effect.tryPromise(() => bot.start()),
        () => Effect.sync(() => bot.stop())
      )
    })
  )
```

---

## 9. Effect Schema

Effect Schema (from the `effect` package, `Schema` namespace) provides type-safe encoding/decoding with excellent TypeScript integration.

### Primitives

```typescript
import { Schema } from "effect"

Schema.String    // Schema<string>
Schema.Number    // Schema<number>
Schema.Boolean   // Schema<boolean>
Schema.Unknown   // Schema<unknown>
Schema.Void      // Schema<void>
```

### Schema.Literal

Exact literal value matching:

```typescript
const Status = Schema.Literal("active", "inactive", "pending")
// Type: Schema<"active" | "inactive" | "pending">

// Access defined literals
Status.literals  // readonly ["active", "inactive", "pending"]
```

### Schema.Struct

Object schemas:

```typescript
const User = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  email: Schema.String,
  active: Schema.Boolean
})
// Type: Schema<{ id: number; name: string; email: string; active: boolean }>
```

### Decoding Unknown Data

```typescript
// Synchronous -- throws ParseError on failure
const user = Schema.decodeUnknownSync(User)({
  id: 1,
  name: "Alice",
  email: "alice@example.com",
  active: true
})

// Effect-based -- returns Effect<A, ParseError>
const userEffect = Schema.decodeUnknown(User)({
  id: 1,
  name: "Alice",
  email: "alice@example.com",
  active: true
})

// Either-based -- returns Either<ParseError, A>
const userEither = Schema.decodeUnknownEither(User)({ ... })
```

### Encoding

```typescript
// Encode back to the "encoded" form
const encoded = Schema.encodeSync(User)(user)
```

### Discriminated Unions

Use `Schema.Literal` as a discriminant in struct variants:

```typescript
const Circle = Schema.Struct({
  kind: Schema.Literal("circle"),
  radius: Schema.Number
})

const Square = Schema.Struct({
  kind: Schema.Literal("square"),
  sideLength: Schema.Number
})

const Triangle = Schema.Struct({
  kind: Schema.Literal("triangle"),
  base: Schema.Number,
  height: Schema.Number
})

const Shape = Schema.Union(Circle, Square, Triangle)
// Type: Schema<
//   | { kind: "circle"; radius: number }
//   | { kind: "square"; sideLength: number }
//   | { kind: "triangle"; base: number; height: number }
// >
```

### Schema.Class

Combines schema definition with a TypeScript class:

```typescript
class UserRecord extends Schema.Class<UserRecord>("UserRecord")({
  id: Schema.Number,
  name: Schema.NonEmptyString,
  role: Schema.Literal("admin", "user")
}) {
  get isAdmin() {
    return this.role === "admin"
  }
}

// Construct with validation
const alice = new UserRecord({ id: 1, name: "Alice", role: "admin" })
alice.isAdmin  // true

// Decode from unknown
const decoded = Schema.decodeUnknownSync(UserRecord)({ id: 1, name: "Alice", role: "user" })
// decoded is an instance of UserRecord with methods
```

### Optional Properties

```typescript
const Config = Schema.Struct({
  host: Schema.String,
  port: Schema.Number,
  debug: Schema.optionalWith(Schema.Boolean, { default: () => false })
})
```

### NanoClaw Pattern: IPC Message Schema

```typescript
const IpcSendMessage = Schema.Struct({
  type: Schema.Literal("send_message"),
  chatId: Schema.Number,
  text: Schema.String,
  replyTo: Schema.optional(Schema.Number)
})

const IpcScheduleTask = Schema.Struct({
  type: Schema.Literal("schedule_task"),
  name: Schema.String,
  schedule: Schema.String,
  context: Schema.Unknown
})

const IpcMessage = Schema.Union(IpcSendMessage, IpcScheduleTask)
// Discriminated on "type" field

// Decode from file contents
const parseIpcFile = (raw: unknown) =>
  Schema.decodeUnknown(IpcMessage)(raw)
// Type: Effect<IpcSendMessage | IpcScheduleTask, ParseError>
```

---

## 10. BunRuntime.runMain

`BunRuntime.runMain` from `@effect/platform-bun` is the primary entry point for running an Effect application on Bun. It handles:

- **Signal handling**: SIGINT (Ctrl+C) and SIGTERM trigger fiber interruption
- **Graceful shutdown**: All finalizers run before exit
- **Exit codes**: 0 for success, 1 for failure
- **Error reporting**: Pretty-printed error output

### Basic Usage

```typescript
import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"

const main = Effect.gen(function* () {
  yield* Effect.log("Starting NanoClaw...")
  // ... application logic ...
  yield* Effect.never  // keep running forever
})

BunRuntime.runMain(main)
```

### With Layers

```typescript
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"

const main = Effect.gen(function* () {
  const telegram = yield* TelegramService
  const db = yield* DatabaseService

  yield* Effect.log("NanoClaw started")

  // Start processing messages
  yield* telegram.startPolling()
})

const AppLive = Layer.mergeAll(
  TelegramLive,
  DatabaseLive,
  SchedulerLive
).pipe(Layer.provide(ConfigLive))

// Provide the full layer and run
BunRuntime.runMain(
  main.pipe(Effect.provide(AppLive))
)
```

### Configuration Options

```typescript
BunRuntime.runMain(main, {
  disableErrorReporting: false,    // default: false
  disablePrettyLogger: false,      // default: false
  teardown: (code, onExit) => {    // custom teardown
    console.log(`Exiting with code ${code}`)
    onExit(code)
  }
})
```

### Signal Handling Behavior

When a signal (SIGINT/SIGTERM) is received:

1. The main fiber is interrupted
2. All registered finalizers execute (in reverse order)
3. All scoped resources are released
4. The process exits

This means every `Effect.addFinalizer` and `Effect.acquireRelease` registered in the application tree will run on Ctrl+C.

### Platform-specific Variants

| Runtime                   | Package                    | Platform    |
| ------------------------- | -------------------------- | ----------- |
| `BunRuntime.runMain`      | `@effect/platform-bun`     | Bun         |
| `NodeRuntime.runMain`     | `@effect/platform-node`    | Node.js     |
| `BrowserRuntime.runMain`  | `@effect/platform-browser` | Browser     |

### NanoClaw Pattern: Main Entry Point

```typescript
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer } from "effect"

const main = Effect.gen(function* () {
  const config = yield* ConfigService
  const telegram = yield* TelegramService
  const db = yield* DatabaseService
  const scheduler = yield* SchedulerService

  yield* Effect.log(`NanoClaw v2 starting (${config.assistantName})`)

  // Start all subsystems
  yield* Effect.all([
    telegram.startPolling(),
    scheduler.start(),
  ], { concurrency: "unbounded" })
}).pipe(
  // Ensure we catch unhandled errors at the top level
  Effect.catchAllCause((cause) =>
    Effect.gen(function* () {
      if (!Cause.isInterruptedOnly(cause)) {
        yield* Effect.logError(`Fatal: ${Cause.pretty(cause)}`)
      }
      yield* Effect.log("Shutting down...")
    })
  )
)

// Build the full application layer
const AppLive = Layer.mergeAll(
  DatabaseLive,
  TelegramLive,
  SchedulerLive,
  IpcWatcherLive,
  SandboxLive
).pipe(
  Layer.provide(ConfigLive)
)

// Run with full signal handling and resource cleanup
BunRuntime.runMain(
  main.pipe(Effect.provide(AppLive))
)
```

---

## Quick Reference: Import Cheatsheet

```typescript
// Core
import { Effect, Layer, Context, Cause, Fiber, Scope, Exit } from "effect"

// Data structures
import { Queue, Ref, SynchronizedRef } from "effect"

// Streaming
import { Stream, Chunk } from "effect"

// Schema
import { Schema } from "effect"

// Utilities
import { Option, Either } from "effect"

// Platform
import { BunRuntime } from "@effect/platform-bun"
```

---

## Sources

- [Effect Official Documentation](https://effect.website/)
- [Effect API Reference](https://effect-ts.github.io/effect/)
- [Effect GitHub Repository](https://github.com/Effect-TS/effect)
- [Effect Schema Basic Usage](https://effect.website/docs/schema/basic-usage/)
- [Effect SynchronizedRef](https://effect.website/docs/state-management/synchronizedref/)
- [Effect Cause](https://effect.website/docs/data-types/cause/)
- [Effect Queue](https://effect.website/docs/concurrency/queue/)
- [Effect Scope & Finalizers](https://effect.website/docs/resource-management/scope/)
- [Effect Stream Creation](https://effect.website/docs/stream/creating/)
- [Effect Resourceful Streams](https://effect.website/docs/stream/resourceful-streams/)
- [Effect Coding Guidelines](https://effect.website/docs/code-style/guidelines/)
- [Effect Platform Runtime](https://effect.website/docs/platform/runtime/)
- [@effect/platform-bun on npm](https://www.npmjs.com/package/@effect/platform-bun)

---

# hex-map-wfc-babylon 設計ドキュメント

## 1. プロジェクト概要

### 1.1 目的

Felix Turner の [hex-map-wfc](https://github.com/felixturner/hex-map-wfc) を、以下の技術スタックで忠実に再実装する。

| 要素 | 移植元 | 移植先 |
|---|---|---|
| 言語 | JavaScript | TypeScript (strict) |
| 3Dエンジン | Three.js r183 (WebGPU) | Babylon.js 8.x (WebGPU) |
| シェーダー | TSL (Three.js Shading Language) | WGSL (直接記述) |
| WFCソルバー | JavaScript (Web Worker) | Rust → WASM (Web Worker) |
| ビルド | Vite | Vite |

### 1.2 原則

**忠実再現。** デモと同等の見た目・機能を再現する。余計な機能追加はしない。

**車輪の再発明を最小限に。** エンジン組み込み機能・既存クレートで済むものは使う。自前実装はオリジナル固有のロジック（ヘックスWFC、バックトラック、3層リカバリー、WGSLシェーダー2本）に限定する。

**全てマイクロモジュール。** 各パッケージは単一責務。パッケージ間依存は型定義パッケージ (`@hex/types`) のみを経由する。

**可能な限り疎結合。** モジュール間はインターフェースとプレーンデータだけで通信する。実装同士は互いの存在を知らない。組み立ては唯一のコンポジションルート (`@hex/app`) で行う。

---

## 2. 移植元の分析

### 2.1 オリジナルの構成

オリジナル (hex-map-wfc) はプロシージャルな中世風島世界を生成する Web アプリケーションで、約4,100個の六角形セルからなるマップを約20秒で構築する。

技術的な構成要素は以下の通り。

**WFCソルバー**として、30種のタイル × 6回転 × 5高度レベル（= 900状態/セル）を用いたモジュラーWFC方式を採用している。19個の独立した六角形グリッドを個別に解き、グリッド間の境界タイルを制約として渡す。トレイルベースのバックトラック（最大500回）に加え、3層のリカバリーシステム（Unfixing → Local-WFC → Mountain fallback）で100%の解決率を実現している。

**レンダリング**には Three.js の WebGPU レンダラーと TSL シェーダーを使用。BatchedMesh でグリッドあたり2ドローコールに収め、全体で約38ドローコールとしている。ポスト処理として GTAO、被写界深度（ティルトシフト）、ビネット、フィルムグレインを適用。動的シャドウマップはカメラビューに合わせてフラスタムフィッティングを行う。

**水面効果**はカスタム TSL シェーダーで実装されており、スクロールするコースティクステクスチャによるスパークルと、海岸マスクからの距離に基づく波アニメーション、入り江での波の減衰処理を含む。

**装飾配置**は WFC ではなく Perlin ノイズベースで、木・建物・装飾物の有機的なクラスタリングを実現している。

**依存ライブラリ**は three (v0.183)、gsap、howler、vite の4つのみ。

### 2.2 タイルアセット

[KayKit Medieval Hexagon Pack](https://github.com/KayKit-Game-Assets/KayKit-Medieval-Hexagon-Pack-1.0) (CC0) をベースに、オリジナル作者が Blender で不足タイル（傾斜河川、河川行き止まり、河川→海岸コネクタ、崖エッジ変種）を補完している。全メッシュは単一の1024×1024グラデーションアトラステクスチャを共有する。

---

## 3. アーキテクチャ

### 3.1 依存グラフ

```
                    ┌─────────────┐
                    │  @hex/types  │   型定義のみ。実装ゼロ。
                    └──────┬──────┘
            ┌──────────┬───┴───┬──────────┐
            ▼          ▼       ▼          ▼
     ┌──────────┐ ┌────────┐ ┌──────┐ ┌──────┐
     │ @hex/wfc │ │ @hex/  │ │@hex/ │ │@hex/ │
     │(Rust→    │ │ render │ │ post │ │ ui   │
     │  WASM)   │ │        │ │      │ │      │
     └──────────┘ └────────┘ └──────┘ └──────┘
            │          │         │        │
            └──────────┴────┬────┴────────┘
                            ▼
                    ┌───────────────┐
                    │   @hex/app    │   唯一の組み立てポイント
                    └───────────────┘
```

横方向の依存は存在しない。`@hex/render` は `@hex/wfc` を知らない。`@hex/wfc` は Babylon.js を知らない。`@hex/post` は WFC を知らない。`@hex/ui` は Babylon.js も WFC も知らない。

### 3.2 ディレクトリ構成

```
hex-map-wfc-babylon/
├── pnpm-workspace.yaml
├── Cargo.toml                    Rust workspace
├── mise.toml                     開発環境定義
├── vite.config.ts
├── tsconfig.base.json
│
├── packages/
│   ├── types/                    @hex/types
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── cell.ts
│   │       ├── placement.ts
│   │       ├── tile-def.ts
│   │       ├── events.ts
│   │       └── config.ts
│   │
│   ├── wfc/                      @hex/wfc
│   │   ├── package.json
│   │   ├── Cargo.toml
│   │   ├── src/                  Rust ソース
│   │   │   ├── lib.rs
│   │   │   ├── hex.rs
│   │   │   ├── tile.rs
│   │   │   ├── grid.rs
│   │   │   ├── solver.rs
│   │   │   ├── backtrack.rs
│   │   │   ├── recovery.rs
│   │   │   ├── multi_grid.rs
│   │   │   ├── placement.rs
│   │   │   ├── rng.rs
│   │   │   └── api.rs
│   │   ├── ts/                   TypeScript 薄ラッパー
│   │   │   ├── worker.ts
│   │   │   └── bridge.ts
│   │   └── wasm/                 ビルド生成物
│   │
│   ├── render/                   @hex/render
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── engine.ts
│   │       ├── scene.ts
│   │       ├── tile-pool.ts
│   │       ├── grid-mesh.ts
│   │       ├── placement-mesh.ts
│   │       ├── shadows.ts
│   │       ├── camera.ts
│   │       └── materials/
│   │           ├── terrain.wgsl
│   │           ├── terrain.ts
│   │           ├── water.wgsl
│   │           ├── water.ts
│   │           └── coast-mask.ts
│   │
│   ├── post/                     @hex/post
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── ao.ts
│   │       ├── dof.ts
│   │       ├── vignette.ts
│   │       ├── grain.ts
│   │       └── pipeline.ts
│   │
│   ├── ui/                       @hex/ui
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts
│   │       └── panel.ts
│   │
│   ├── assets/                   @hex/assets
│   │   ├── package.json
│   │   ├── tiles/                .glb ファイル群
│   │   ├── textures/             パレット、caustic 等
│   │   └── manifest.ts
│   │
│   └── app/                      @hex/app
│       ├── package.json
│       └── src/
│           ├── main.ts
│           └── orchestrator.ts
```

---

## 4. パッケージ詳細

### 4.1 @hex/types — 契約定義

ランタイムコードゼロ。型と定数のみ。全パッケージがここだけに依存する。

```typescript
// cell.ts
export interface CellResult {
  readonly q: number;
  readonly r: number;
  readonly s: number;
  readonly tileId: number;
  readonly rotation: number; // 0–5
  readonly elevation: number; // 0–4
  readonly worldX: number;
  readonly worldY: number;
  readonly worldZ: number;
}

export interface GridResult {
  readonly gridIndex: number;
  readonly cells: readonly CellResult[];
}
```

```typescript
// placement.ts
export type PlacementType = "tree" | "building" | "decoration";

export interface PlacementItem {
  readonly type: PlacementType;
  readonly meshId: string;
  readonly worldX: number;
  readonly worldY: number;
  readonly worldZ: number;
  readonly rotationY: number;
  readonly scale: number;
}
```

```typescript
// tile-def.ts
export type EdgeType = "grass" | "road" | "river" | "coast" | "cliff" | "water";

export interface TileDef {
  readonly name: string;
  readonly mesh: string;
  readonly edges: {
    readonly NE: EdgeType;
    readonly E: EdgeType;
    readonly SE: EdgeType;
    readonly SW: EdgeType;
    readonly W: EdgeType;
    readonly NW: EdgeType;
  };
  readonly weight: number;
}
```

```typescript
// events.ts
export interface WfcEvents {
  onGridSolved: (chunk: PackedGridChunk) => void;
  onPlacementsGenerated: (chunk: PackedPlacementChunk) => void;
  onAllSolved: (summary: BuildSummary) => void;
  onProgress: (progress: BuildProgress) => void;
  onError: (error: { message: string; gridIndex?: number; recoverable: boolean }) => void;
}

export interface RenderEvents {
  onReady: () => void;
  onCameraChanged: (zoom: number) => void;
}

export interface UiEvents {
  onConfigChanged: <K extends keyof MapConfig>(
    key: K,
    value: MapConfig[K],
  ) => void;
  onBuildRequested: (seed: number) => void;
  onBuildAllRequested: (seed: number) => void;
}
```

```typescript
// config.ts
export interface MapConfig {
  // --- WFC ---
  readonly seed: number;
  readonly gridRadius: number;
  readonly maxBacktracks: number;
  readonly localWfcAttempts: number;
  // --- AO ---
  readonly aoEnabled: boolean;
  readonly aoRadius: number;
  readonly aoSamples: number;
  // --- DoF ---
  readonly dofEnabled: boolean;
  readonly dofFocalLength: number;
  readonly dofFStop: number;
  // --- Vignette ---
  readonly vignetteEnabled: boolean;
  readonly vignetteWeight: number;
  // --- Grain ---
  readonly grainEnabled: boolean;
  readonly grainIntensity: number;
  // --- Water ---
  readonly waveSpeed: number;
  readonly waveFrequency: number;
  readonly sparkleIntensity: number;
  // --- Shadow ---
  readonly shadowEnabled: boolean;
  readonly shadowResolution: number;
  // --- Camera ---
  readonly cameraAlpha: number;
  readonly cameraBeta: number;
  readonly cameraRadius: number;
}

export const DEFAULT_CONFIG: MapConfig = {
  seed: 42,
  gridRadius: 6,
  maxBacktracks: 500,
  localWfcAttempts: 5,
  aoEnabled: true,
  aoRadius: 2.0,
  aoSamples: 16,
  dofEnabled: true,
  dofFocalLength: 150,
  dofFStop: 1.4,
  vignetteEnabled: true,
  vignetteWeight: 1.5,
  grainEnabled: true,
  grainIntensity: 15,
  waveSpeed: 1.0,
  waveFrequency: 8.0,
  sparkleIntensity: 0.5,
  shadowEnabled: true,
  shadowResolution: 2048,
  cameraAlpha: -Math.PI / 4,
  cameraBeta: Math.PI / 3,
  cameraRadius: 50,
} as const;
```

### 4.2 @hex/wfc — WFCソルバー (Rust → WASM)

#### 4.2.1 Rust 内部構成

```
依存方向（左→右）:

hex.rs ← 依存なし
rng.rs ← 依存なし
tile.rs ← hex
grid.rs ← hex, tile
solver.rs ← grid, rng
backtrack.rs ← solver
recovery.rs ← solver, backtrack
multi_grid.rs ← grid, solver, recovery
placement.rs ← hex, rng, noise(外部crate)
api.rs ← multi_grid, placement, wasm_bindgen(外部), serde(外部)
```

`api.rs` だけが `wasm_bindgen` に依存する。他の全モジュールはピュア Rust でありブラウザ API への依存はゼロ。`cargo test` で全テストが完結する。

**Rust モジュール責務一覧：**

`hex.rs` はキューブ座標系 (q, r, s) の定義、近傍算出（6方向 + 対角）、距離計算、回転（60°刻み）、ワールド座標変換を担当する。Red Blob Games のアルゴリズムをそのまま実装する。

`tile.rs` は 30 種のタイル定義、6辺エッジタイプ、重み、回転展開（30 × 6 = 180 バリエーション生成）、高度レベル（5段階）を含む状態空間の定義を担当する。

`grid.rs` は単一六角形グリッド（半径6 = 217セル）のデータ構造、セルごとの可能状態ビットセット管理、境界セルの識別を担当する。

`solver.rs` は WFC コアアルゴリズムとして、エントロピー計算による最小エントロピーセル選択、状態収縮（重み付きランダム選択）、制約伝播（隣接エッジマッチング）を担当する。

`backtrack.rs` はトレイルベースのバックトラックを担当する。伝播中に除去した可能状態をトレイルとして記録し、矛盾発生時にトレイルを巻き戻して別の選択を試行する。最大500回。

`recovery.rs` は 3 層リカバリーシステムを担当する。Layer 1 の Unfixing は境界制約セルを解除して2セル先のアンカーを新制約とする。Layer 2 の Local-WFC は問題セル周辺の半径2領域（19セル）を局所的に再解決する（最大5回）。Layer 3 の Mountain fallback は解決不能セルを山タイルで置換する。

`multi_grid.rs` は 19 グリッドのモジュラー WFC を担当する。中心1 + 内環6 + 外環12 のヘックス・オブ・ヘックス配置、解決順序の決定、クロスグリッド境界制約の注入を含む。

`placement.rs` は Perlin ノイズベースの装飾配置を担当する。木密度マップ、建物密度マップ、道路末端への建物配置、海岸への港・風車配置、丘頂上へのヘンジ配置を含む。

`rng.rs` はシード付き決定的疑似乱数生成器を担当する。

`api.rs` は `#[wasm_bindgen]` エクスポート境界として、`MapGenerator` 構造体のコンストラクタ、`solve_grid`、`solve_all`、`generate_placements` メソッドを TypeScript 側に公開する。データは `serde-wasm-bindgen` で `JsValue` に変換する。

#### 4.2.2 Cargo.toml

```toml
[package]
name = "wfc-core"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
wasm-bindgen = "0.2"
serde = { version = "1", features = ["derive"] }
serde-wasm-bindgen = "0.6"
noise = "0.9"
fastrand = "2"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
strip = true
```

#### 4.2.3 TypeScript 薄ラッパー

```typescript
// ts/bridge.ts
import type {
  BuildSummary,
  GridResult,
  PlacementItem,
  WfcEvents,
} from "@hex/types";

export class WfcBridge {
  constructor(seed: number);
  ready(): Promise<void>;
  solveGrid(
    gridQ: number,
    gridR: number,
    tileTypes?: number[],
  ): Promise<GridResult>;
  solveAll(seed: number): Promise<readonly GridResult[]>;
  buildAllProgressively(seed: number): Promise<BuildSummary>;
  generatePlacements(
    grids: readonly GridResult[],
    seed: number,
  ): Promise<readonly PlacementItem[]>;
  reset(): void;
  subscribe(events: Partial<WfcEvents>): () => void;
  dispose(): void;
}
```

`worker.ts` は Web Worker 内で WASM を初期化し、`postMessage` / `onmessage` でメインスレッドと通信する。`bridge.ts` は Worker への呼び出しを Promise でラップする薄いファサードである。

`solveGrid()` は単独実行でも `baseSeed + gridIndex` を使う。したがって、同じベース seed と同じグリッド座標なら、単独 solve と `solveAll()` / `buildAllProgressively()` は同じ seed 規則で実行される。

`WfcBridge` は単一の `WfcEngine.global_map` を共有するため、`solveGrid()`、`solveAll()`、`generatePlacements()`、`buildAllProgressively()`、`reset()` は同時に 1 つしか実行できない。並行呼び出しは queue されず、`WfcBridgeError` の `kind === "busy"` で即失敗する。

### 4.3 @hex/render — Babylon.js シーン構築

#### 4.3.1 公開インターフェース

```typescript
import type {
  GridResult,
  PackedGridChunk,
  PackedPlacementChunk,
  PlacementItem,
  MapConfig,
  RenderEvents,
} from "@hex/types";

export interface HexRenderer {
  addGrid(result: GridResult): void;
  addPackedGrid(chunk: PackedGridChunk): void;
  addPlacements(items: readonly PlacementItem[]): void;
  addPackedPlacements(chunk: PackedPlacementChunk): void;
  clear(): void;
  updateConfig(config: Partial<MapConfig>): void;
  subscribe(events: Partial<RenderEvents>): () => void;
  dispose(): void;
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  config: MapConfig,
): Promise<HexRenderer>;
```

WFC への依存はゼロ。受け取るのは `@hex/types` で定義されたプレーンデータのみ。

#### 4.3.2 内部モジュール責務

`engine.ts` は `WebGPUEngine` の生成を担当する。`canvas` 要素を受け取り、`engine.initAsync()` で WebGPU バックエンドを初期化する。

`scene.ts` は `Scene`、`HemisphericLight`、`DirectionalLight` の初期化を担当する。

`camera.ts` は `ArcRotateCamera` の生成と制御を担当する。ズーム変更時に `RenderEvents.onCameraChanged` を発火する。

`tile-pool.ts` はタイルメッシュのテンプレートを保持し、地形・装飾物の thin instances ソースとして共有する。

`grid-mesh.ts` は packed なグリッドチャンクを受け取り、タイルメッシュ種別ごとに行列バッファを構築して `thinInstanceSetBuffer("matrix", ...)` を更新する。グリッドごとの寄与を保持するため、段階生成中の差し替えや再投入にも対応できる。

`placement-mesh.ts` は `PlacementItem[]` を受け取り、同一メッシュIDごとに Thin Instances でバッチ描画する。各メッシュIDにつき1ドローコール。

`shadows.ts` は `DirectionalLight` に対する `ShadowGenerator` を構成する。`autoCalcShadowZBounds = true` でカメラビューに応じたフラスタムフィッティングを行い、ズームレベルに関わらず鮮明なシャドウを維持する。

#### 4.3.3 カスタム WGSL シェーダー

**地形マテリアル (`terrain.wgsl`)** はオリジナルの `MeshPhysicalNodeMaterial` + TSL カラーノードに対応する。インスタンスカラーに高度情報をエンコードし、2枚のパレットテクスチャ（低地 = 夏色、高地 = 冬色）をブレンドする。

Babylon.js での WGSL ShaderMaterial 構成：

```typescript
import { ShaderMaterial, ShaderLanguage, ShaderStore } from "@babylonjs/core";

ShaderStore.ShadersStoreWGSL["terrainVertexShader"] = terrainVertexWGSL;
ShaderStore.ShadersStoreWGSL["terrainFragmentShader"] = terrainFragmentWGSL;

const material = new ShaderMaterial(
  "terrain",
  scene,
  { vertex: "terrain", fragment: "terrain" },
  {
    attributes: ["position", "normal", "uv"],
    uniformBuffers: ["Scene", "Mesh"],
    shaderLanguage: ShaderLanguage.WGSL,
  },
);
```

Babylon.js の WGSL ShaderMaterial では、エントリポイントを `@vertex fn main(input: VertexInputs) -> FragmentInputs` / `@fragment fn main(input: FragmentInputs) -> FragmentOutputs` の形式で宣言する。`@group/@binding` デコレーションはエンジンが自動付与するため記述しない。attribute は `vertexInputs.position`、varying は `vertexOutputs.varName` / `fragmentInputs.varName`、uniform は `uniforms.varName` でアクセスする。

**水面マテリアル (`water.wgsl`)** はオリジナルの水面 TSL シェーダーに対応する。コーストマスクテクスチャからの距離に基づく波アニメーション（sin 波バンド）、入り江マスクによる波の減衰、スクロールするコースティクステクスチャによるスパークルを実装する。

**コーストマスク (`coast-mask.ts`)** は `RenderTargetTexture` を用いてマップ全体を上方向の正射影でレンダリングし、陸地 = 白、水面 = 黒のマスクを生成する。これをブラー（膨張 + ガウシアン）して海岸からの距離勾配テクスチャを作る。入り江検出は CPU 側で各水セルの近傍を走査する。

### 4.4 @hex/post — ポスト処理

#### 4.4.1 公開インターフェース

```typescript
import type { MapConfig } from "@hex/types";
import type { Scene, Camera } from "@babylonjs/core";

export interface PostStack {
  updateConfig(config: Partial<MapConfig>): void;
  onCameraZoomChanged(zoom: number): void;
  dispose(): void;
}

export function createPostStack(
  scene: Scene,
  camera: Camera,
  config: MapConfig,
): PostStack;
```

WFC への依存はゼロ。Render の内部実装にも依存しない。Scene と Camera だけ受け取る。

#### 4.4.2 オリジナル→Babylon.js 対応

**GTAO → `SSAO2RenderingPipeline`。** Babylon.js は GTAO を直接提供していないが、`SSAO2RenderingPipeline` が同等品質の SSAO を提供する。`radius`、`totalStrength`、`samples` で調整する。オリジナルが半解像度で実行しているのと同様に、`ssaoRatio` を 0.5 に設定する。

**Depth of Field → `DefaultRenderingPipeline.depthOfField`。** `focalLength` を高く設定するとティルトシフト（ミニチュア）効果が得られる。オリジナルと同様に `focalLength` をカメラズームに連動させる（`onCameraZoomChanged` 経由）。

**Vignette → `DefaultRenderingPipeline.imageProcessing.vignetteEnabled`。** `vignetteWeight` と `vignetteColor` で調整する。

**Film Grain → `DefaultRenderingPipeline.grain`。** `grainIntensity` と `grainAnimated` で調整する。

### 4.5 @hex/ui — GUI パネル

#### 4.5.1 公開インターフェース

```typescript
import type { MapConfig, UiEvents } from "@hex/types";

export interface UiPanel {
  setConfig(config: MapConfig): void;
  subscribe(events: Partial<UiEvents>): () => void;
  dispose(): void;
}

export function createUiPanel(
  container: HTMLElement,
  config: MapConfig,
): UiPanel;
```

Babylon.js への依存はゼロ。WFC への依存もゼロ。lil-gui で DOM 操作し、設定変更をコールバックで上位に投げるだけ。

### 4.6 @hex/assets — 静的リソース

タイルメッシュ (.glb)、テクスチャ (パレット、caustic)、`manifest.ts`（アセットパスの型付き定義）を含む。ロジックは持たない。

### 4.7 @hex/app — コンポジションルート

全モジュールを import する唯一のパッケージ。各モジュールのファクトリ関数を呼び出してインスタンスを生成し、イベントを配線する。

```typescript
// orchestrator.ts
import { DEFAULT_CONFIG, type MapConfig } from "@hex/types";
import { createWfcBridge } from "@hex/wfc";
import { createRenderer } from "@hex/render";
import { createPostStack } from "@hex/post";
import { createUiPanel } from "@hex/ui";

export async function boot(
  canvas: HTMLCanvasElement,
  uiContainer: HTMLElement,
) {
  const config: MapConfig = { ...DEFAULT_CONFIG };

  const wfc = await createWfcBridge(config);
  const renderer = await createRenderer(canvas, config);
  const post = createPostStack(
    renderer.getScene(),
    renderer.getCamera(),
    config,
  );
  const ui = createUiPanel(uiContainer, config);

  // UI → WFC + Render
  ui.subscribe({
    onBuildAllRequested: async (seed) => {
      renderer.clear();
      await wfc.buildAllProgressively(seed);
    },
    onConfigChanged: (key, value) => {
      const patch = { [key]: value } as Partial<MapConfig>;
      wfc.updateConfig(patch);
      renderer.updateConfig(patch);
      post.updateConfig(patch);
    },
  });

  // Render → Post（カメラズーム連動 DoF）
  renderer.subscribe({
    onCameraChanged: (zoom) => post.onCameraZoomChanged(zoom),
  });

  // WFC → Render（段階的構築）
  wfc.subscribe({
    onGridSolved: (chunk) => renderer.addPackedGrid(chunk),
    onPlacementsGenerated: (chunk) => renderer.addPackedPlacements(chunk),
  });
}
```

---

## 5. 機能マッピング一覧

| オリジナルの機能               | 担当パッケージ | 担当ファイル      | 実装方法                        |
| ------------------------------ | -------------- | ----------------- | ------------------------------- |
| WFC ソルバー                   | @hex/wfc       | solver.rs         | 自前 (Rust)                     |
| バックトラック (トレイル方式)  | @hex/wfc       | backtrack.rs      | 自前 (Rust)                     |
| 3層リカバリー                  | @hex/wfc       | recovery.rs       | 自前 (Rust)                     |
| 19グリッド モジュラーWFC       | @hex/wfc       | multi_grid.rs     | 自前 (Rust)                     |
| ヘックス座標 (キューブ方式)    | @hex/wfc       | hex.rs            | 自前 (Red Blob Games 準拠)      |
| Perlin ノイズ配置              | @hex/wfc       | placement.rs      | `noise` クレート                |
| シード付き RNG                 | @hex/wfc       | rng.rs            | `fastrand` クレート             |
| Web Worker 実行                | @hex/wfc       | worker.ts         | ブラウザ標準 API                |
| WebGPU エンジン初期化          | @hex/render    | engine.ts         | `@babylonjs/core` WebGPUEngine  |
| glTF タイルロード              | @hex/render    | tile-pool.ts      | `@babylonjs/loaders`            |
| 地形バッチ描画                | @hex/render    | grid-mesh.ts      | Babylon.js Thin Instances       |
| 装飾物バッチ描画               | @hex/render    | placement-mesh.ts | Babylon.js Thin Instances       |
| 地形シェーダー (高度ブレンド)  | @hex/render    | terrain.wgsl      | 自前 WGSL                       |
| 水面シェーダー (caustic+波)    | @hex/render    | water.wgsl        | 自前 WGSL                       |
| コーストマスク生成             | @hex/render    | coast-mask.ts     | `RenderTargetTexture`           |
| 入り江検出 (surroundedness)    | @hex/render    | coast-mask.ts     | 自前 (CPU)                      |
| SSAO (GTAO相当)                | @hex/post      | ao.ts             | `SSAO2RenderingPipeline`        |
| Depth of Field (tilt-shift)    | @hex/post      | dof.ts            | `DefaultRenderingPipeline`      |
| Vignette                       | @hex/post      | vignette.ts       | `DefaultRenderingPipeline`      |
| Film Grain                     | @hex/post      | grain.ts          | `DefaultRenderingPipeline`      |
| 動的シャドウマップ             | @hex/render    | shadows.ts        | `ShadowGenerator` + auto bounds |
| カメラ制御                     | @hex/render    | camera.ts         | `ArcRotateCamera`               |
| UI パネル (50+パラメータ)      | @hex/ui        | panel.ts          | `lil-gui`                       |

**自前実装が必要なもの：** WFC ソルバー関連一式（ヘックス WFC + バックトラック + 3 層リカバリー + モジュラーグリッド）、ヘックス座標、WGSL シェーダー 2 本（地形・水面）、コーストマスク生成 + 入り江検出。

---

## 6. ビルドパイプライン

### 6.1 開発環境 (mise)

```toml
# mise.toml
[tools]
node = "22"
rust = { version = "stable", targets = "wasm32-unknown-unknown" }
"ubi:rustwasm/wasm-bindgen" = { version = "0.2.100", extract_all = "true" }
"ubi:WebAssembly/binaryen" = { version = "version_123", extract_all = "true", bin_path = "bin" }
```

wasm-pack は 2025 年 7 月にサンセットされたため使用しない。`cargo build` → `wasm-bindgen` → `wasm-opt` を直接チェーンする。

### 6.2 Rust → WASM ビルド

```bash
cargo build --release --target wasm32-unknown-unknown -p wfc-core

wasm-bindgen \
  --target web \
  ./target/wasm32-unknown-unknown/release/wfc_core.wasm \
  --out-dir ./packages/wfc/wasm

wasm-opt -Oz \
  ./packages/wfc/wasm/wfc_core_bg.wasm \
  -o ./packages/wfc/wasm/wfc_core_bg.wasm
```

### 6.3 npm scripts

```jsonc
// package.json (root)
{
  "scripts": {
    "build:wasm": "cargo build --release --target wasm32-unknown-unknown -p wfc-core && wasm-bindgen --target web ./target/wasm32-unknown-unknown/release/wfc_core.wasm --out-dir ./packages/wfc/wasm && wasm-opt -Oz ./packages/wfc/wasm/wfc_core_bg.wasm -o ./packages/wfc/wasm/wfc_core_bg.wasm",
    "dev": "pnpm run build:wasm && vite",
    "build": "pnpm run build:wasm && vite build",
    "test:rust": "cargo test -p wfc-core",
    "test": "pnpm run test:rust",
  },
}
```

### 6.4 pnpm workspace

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
```

### 6.5 パッケージ間依存

```jsonc
// @hex/types — 外部依存なし
{ "name": "@hex/types" }

// @hex/wfc — 型のみ依存。Babylon.js なし
{ "name": "@hex/wfc",
  "dependencies": { "@hex/types": "workspace:*" } }

// @hex/render — 型 + Babylon.js
{ "name": "@hex/render",
  "dependencies": {
    "@hex/types": "workspace:*",
    "@babylonjs/core": "^8.45",
    "@babylonjs/loaders": "^8.45" } }

// @hex/post — 型 + Babylon.js (core のみ)
{ "name": "@hex/post",
  "dependencies": {
    "@hex/types": "workspace:*",
    "@babylonjs/core": "^8.45" } }

// @hex/ui — 型 + lil-gui。Babylon.js なし
{ "name": "@hex/ui",
  "dependencies": {
    "@hex/types": "workspace:*",
    "lil-gui": "^0.20" } }

// @hex/assets — 依存なし（静的ファイル + manifest）
{ "name": "@hex/assets" }

// @hex/app — 全パッケージを組み立て
{ "name": "@hex/app",
  "dependencies": {
    "@hex/types": "workspace:*",
    "@hex/wfc": "workspace:*",
    "@hex/render": "workspace:*",
    "@hex/post": "workspace:*",
    "@hex/ui": "workspace:*",
    "@hex/assets": "workspace:*" } }
```

### 6.6 Vite 設定

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  root: "packages/app",
  plugins: [wasm()],
  build: {
    target: "esnext",
  },
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
});
```

---

## 7. 疎結合の検証

### 7.1 モジュール差し替えシナリオ

| シナリオ                                 | 変更範囲                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| WFC を Rust WASM から JS 実装に差し替え  | `@hex/wfc` 内部のみ。`WfcBridge` interface が同じなら他は無変更              |
| Babylon.js を Three.js に戻す            | `@hex/render` + `@hex/post` のみ。interface 維持なら `@hex/app` の配線も同一 |
| UI を lil-gui から Babylon.js GUI に変更 | `@hex/ui` のみ                                                               |
| ポスト処理を全カスタム WGSL に置き換え   | `@hex/post` のみ                                                             |
| WFC ソルバーだけユニットテスト           | `cargo test` 完結。ブラウザ不要                                              |
| Renderer だけビジュアルテスト            | モック `GridResult` を流し込める                                             |
| 別のタイルセットに差し替え               | `@hex/assets` + `@hex/types/tile-def.ts` のみ                                |

### 7.2 各パッケージの知識境界

| パッケージ  | Babylon.js を知るか | WFC を知るか | DOM を知るか  |
| ----------- | ------------------- | ------------ | ------------- |
| @hex/types  | No                  | No           | No            |
| @hex/wfc    | No                  | Yes (自身)   | No (Worker内) |
| @hex/render | Yes                 | No           | canvas のみ   |
| @hex/post   | Yes (Scene/Camera)  | No           | No            |
| @hex/ui     | No                  | No           | Yes           |
| @hex/assets | No                  | No           | No            |
| @hex/app    | Yes (間接)          | Yes (間接)   | Yes           |

---

## 8. 実装順序

```
Phase 1: 基盤確立
  ① @hex/types の全型定義
  ② wfc-core の hex.rs + tile.rs + rng.rs（cargo test で検証）
  ③ wfc-core の solver.rs + backtrack.rs（単一グリッド解決の cargo test）
  ④ WASM ビルドパイプライン確立（mise.toml + build:wasm スクリプト）

Phase 2: フル WFC
  ⑤ multi_grid.rs + recovery.rs（19 グリッド + 3 層リカバリーの cargo test）
  ⑥ placement.rs（Perlin ノイズ配置の cargo test）
  ⑦ api.rs + ts/worker.ts + ts/bridge.ts（Worker 経由の呼び出し確認）

Phase 3: レンダリング基盤
  ⑧ @hex/render の engine.ts + scene.ts + camera.ts（空シーン表示）
  ⑨ tile-pool.ts（glTF ロード確認）
  ⑩ grid-mesh.ts（1 グリッド分の MergeMeshes 描画）
  ⑪ 全 19 グリッド描画 + placement-mesh.ts（Thin Instances）

Phase 4: ビジュアル
  ⑫ terrain.wgsl + terrain.ts（高度ブレンド + パレットテクスチャ）
  ⑬ water.wgsl + water.ts + coast-mask.ts（水面効果一式）
  ⑭ shadows.ts（動的シャドウマップ）

Phase 5: ポスト処理
  ⑮ @hex/post の ao.ts（SSAO2）
  ⑯ dof.ts + vignette.ts + grain.ts（DefaultRenderingPipeline）
  ⑰ pipeline.ts（統合 + カメラズーム連動 DoF）

Phase 6: 仕上げ
  ⑱ @hex/ui の panel.ts（50+ パラメータ GUI）
  ⑲ @hex/app の orchestrator.ts（全配線）
  ⑳ サウンド（howler.js）+ アニメーション（gsap）
```

---

## 9. 技術的な注意事項

### 9.1 BatchedMesh → MergeMeshes の差異

Three.js の `BatchedMesh` は描画時に異なるジオメトリを1ドローコールで描画する動的バッチング機構であり、個々のインスタンス変換を差し替えられる。Babylon.js では地形・装飾物ともに thin instances を使い、Worker から段階的に届く packed 行列データをそのまま反映する方針を採る。

### 9.2 SSAO2 と GTAO の差異

オリジナルは Three.js の GTAO (Ground Truth Ambient Occlusion) を使用する。Babylon.js は GTAO を直接提供していないが、`SSAO2RenderingPipeline` が十分な品質の SSAO を提供する。`radius`、`totalStrength`、`samples` の調整でオリジナルに近い見た目を達成できる。半解像度実行は `ssaoRatio: 0.5` で指定する。

### 9.3 WGSL の Babylon.js 固有構文

Babylon.js の `ShaderMaterial` で WGSL を書く場合、標準 WGSL とは異なる規約がある。`varying`、`attribute`、`uniform` の宣言はGLSL風の構文を使用する。入出力は `vertexInputs.*` / `vertexOutputs.*` / `fragmentInputs.*` / `fragmentOutputs.*` でアクセスする。`@group(X) @binding(Y)` はエンジンが自動付与するため記述してはならない。NDC の z 軸範囲が WebGL の [-1, 1] ではなく WebGPU の [0, 1] であることに注意する。

### 9.4 wasm-pack の不使用

wasm-pack は 2025 年 7 月に rustwasm ワーキンググループとともにサンセット・アーカイブされた。本プロジェクトでは `cargo build` → `wasm-bindgen-cli` → `wasm-opt` を直接チェーンする。開発環境のツールバージョン管理には mise を使用する。`wasm-bindgen` のライブラリバージョンと CLI バージョンは一致させること。

---

## 10. 外部依存一覧

### 10.1 Rust (Cargo)

| クレート           | バージョン           | 用途                     |
| ------------------ | -------------------- | ------------------------ |
| wasm-bindgen       | 0.2                  | WASM ↔ JS バインディング |
| serde              | 1 (features: derive) | 構造体シリアライズ       |
| serde-wasm-bindgen | 0.6                  | serde → JsValue 変換     |
| noise              | 0.9                  | Perlin ノイズ生成        |
| fastrand           | 2                    | 軽量シード付き RNG       |

### 10.2 TypeScript (npm)

| パッケージ         | バージョン | 用途          | 使用するモジュール     |
| ------------------ | ---------- | ------------- | ---------------------- |
| @babylonjs/core    | ^8.45      | 3D エンジン   | @hex/render, @hex/post |
| @babylonjs/loaders | ^8.45      | glTF ローダー | @hex/render            |
| lil-gui            | ^0.20      | GUI パネル    | @hex/ui                |
| vite               | ^6         | ビルドツール  | root                   |
| vite-plugin-wasm   | ^3         | WASM ローダー | root                   |
| typescript         | ^5.7       | 型チェック    | root                   |

### 10.3 開発ツール (mise)

| ツール              | バージョン  | 用途                    |
| ------------------- | ----------- | ----------------------- |
| node                | 22          | JS ランタイム           |
| rust                | stable      | Rust コンパイラ         |
| wasm-bindgen-cli    | 0.2.100     | WASM バインディング生成 |
| binaryen (wasm-opt) | version_123 | WASM 最適化             |

---

## 11. ライセンス

移植元のライセンス状況：

| リソース                       | ライセンス                   |
| ------------------------------ | ---------------------------- |
| hex-map-wfc (Felix Turner)     | MIT                          |
| KayKit Medieval Hexagon Pack   | CC0 1.0 Universal            |
| WaveFunctionCollapse (mxgmn)   | MIT                          |
| Red Blob Games Hexagonal Grids | 参考資料（コード実装は独自） |

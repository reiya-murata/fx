# 実装ロードマップ

## Phase 1: デモトレード成立（1〜2週間）
- Next.js プロジェクト初期化
- 価格ストリーム基盤（ダミー or プロバイダ接続）
- 注文/約定シミュレーション
- 建玉・損益表示
- 初期資金 1,000,000円 固定

## Phase 2: データ保存と分析（1週間）
- PostgreSQL スキーマ実装
- 注文/約定/トレード永続化
- 分析API（summary, by-hour, by-weekday）
- 分析ダッシュボードUI

## Phase 3: AIアシスタント（1〜2週間）
- ルールベース提案エンジン
- 推奨エントリー/利確/損切り生成
- 提案採用ログ保存
- 採用時/非採用時比較分析

## Phase 4: 精度改善（継続）
- 相場レジーム判定（トレンド/レンジ）
- 連敗時ロット抑制提案
- 指標前後の警告強化

## 受け入れ基準（MVP）
- リアルタイム価格を表示できる
- 注文から約定、損益反映まで動作する
- 全取引データが保存される
- 勝率・利益・PF・最大DDが分析画面で確認できる
- AI提案がリアルタイム表示される

## 技術スタック提案
- Frontend: Next.js + TypeScript + Lightweight Charts
- Backend: Node.js + Fastify + WebSocket
- DB: PostgreSQL
- Cache/Realtime: Redis
- ORM: Prisma


---
name: Angular Dashboard Patterns
description: Angular 17 standalone component patterns for real-time dashboards — Signals, Chart.js, WebSocket integration, and responsive layout
type: reference
---

## Angular Signals for Reactive State

Use `signal<T>()` for all mutable component state. Prefer `computed()` for derived values. Do not mix `signal` and `BehaviorSubject` in the same component.

```typescript
readonly data = signal<FlowOverview | null>(null);
readonly loading = signal(true);
readonly topApps = signal<AppRow[]>([]);
```

Update with `.set()` or `.update()`:
```typescript
this.data.set(response);
this.topApps.update(prev => [...prev, newRow]);
```

## Chart.js + ng2-charts Responsive Setup

`maintainAspectRatio: false` requires the canvas parent to have an **explicit height**. Setting only `max-height` on the canvas is insufficient.

Correct pattern — wrap every `<canvas>` in a positioned div:
```html
<div class="chart-wrap">
  <canvas baseChart [data]="chartData" ...></canvas>
</div>
```

Required CSS:
```css
.chart-wrap {
  position: relative;
  height: 260px;
  width: 100%;
}
.chart-wrap canvas {
  position: absolute;
  inset: 0;
}
```

**Doughnut overflow fix**: `legend: { position: 'right' }` consumes ~40% of horizontal space. Switch to `position: 'bottom'` for charts inside constrained containers.

## WebSocket Service Pattern

Authenticate via JWT query param (`?token=<jwt>`). Always auto-start push on connect — do not require a separate `subscribe` message.

```typescript
private ws?: WebSocket;
private wsTimer?: ReturnType<typeof setInterval>;

connectWs(): void {
  const token = localStorage.getItem('token');
  this.ws = new WebSocket(`ws://localhost:3000/ws?token=${token}`);
  this.ws.onmessage = (e) => this.handleWsMessage(JSON.parse(e.data));
  this.ws.onclose = () => this.scheduleReconnect();
}

ngOnDestroy(): void {
  this.ws?.close();
  clearInterval(this.wsTimer);
}
```

## Decoupling Chart Refresh from WS Push

Slow-moving historical charts (Bandwidth Over Time, hourly buckets) must use their **own `setInterval`**, independent of the WebSocket push cycle. Otherwise the chart updates every WS tick regardless of the configured interval.

```typescript
const BW_REFRESH_MS = 15_000;  // module-level constant, ABOVE @Component

@Component({ ... })
export class DashboardComponent implements OnInit, OnDestroy {
  private bwTimer?: ReturnType<typeof setInterval>;

  ngOnInit(): void {
    this.loadBandwidth();
    this.bwTimer = setInterval(() => this.loadBandwidth(), BW_REFRESH_MS);
  }

  ngOnDestroy(): void {
    clearInterval(this.bwTimer);
  }
}
```

**Critical placement**: Module-level constants must appear **above** `@Component({...})`. Inserting between `})` and `export class` breaks the decorator-class binding → `TS1206` / `TS-992007`.

## Responsive Grid Layout

```css
.charts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1rem;
}

.chart-card {
  min-width: 0;  /* prevents overflow in grid; do NOT set max-height on canvas here */
}
```

`min-width: 0` on grid children prevents charts from overflowing the grid cell.

## Modal Dialogs

Use `MatDialog` + `panelClass: 'dark-dialog'`. Never use `window.open` for in-app modals. The `FlowDetailModalComponent` is declared inline in the same file as its parent.

```typescript
this.dialog.open(FlowDetailModalComponent, {
  data: row,
  panelClass: 'dark-dialog',
  width: '700px',
});
```

`dark-dialog` must be defined in `src/styles.scss` (global scope), not in component styles.

## Route Registration

All feature routes use lazy loading:
```typescript
{ path: 'flows', loadComponent: () => import('./features/flows/flows.component').then(m => m.FlowsComponent) }
```

API calls go through `src/app/core/services/api.service.ts`. Auth token in `localStorage['token']`; `AuthInterceptor` attaches it as `Bearer` header automatically.

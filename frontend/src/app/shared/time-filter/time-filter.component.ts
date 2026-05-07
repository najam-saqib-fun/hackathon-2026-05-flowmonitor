import {
  Component, EventEmitter, Output, signal, computed
} from '@angular/core';
import { NgIf, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';

export interface TimeFilter {
  start: string | null;
  end: string | null;
  label?: string;
}

@Component({
  selector: 'app-time-filter',
  standalone: true,
  imports: [
    NgIf, NgClass, FormsModule,
    MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatTooltipModule,
  ],
  template: `
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:0.5rem;background:#12151e;border:1px solid #2d3148;border-radius:10px;padding:0.6rem 1rem;">
      <!-- Quick presets -->
      <span style="font-size:0.75rem;color:#64748b;margin-right:0.25rem;">Quick:</span>
      <button *ngFor="let p of presets" mat-stroked-button
              [ngClass]="activePreset() === p.key ? 'active-preset' : ''"
              style="height:30px;line-height:30px;font-size:0.78rem;padding:0 10px;min-width:0;"
              (click)="applyPreset(p)">
        {{ p.label }}
      </button>

      <div style="width:1px;height:24px;background:#2d3148;margin:0 0.25rem;"></div>

      <!-- Custom range -->
      <span style="font-size:0.75rem;color:#64748b;">Custom:</span>
      <input type="datetime-local" [(ngModel)]="customStart"
             style="background:#1a1d27;border:1px solid #3d4460;border-radius:6px;color:#e2e8f0;padding:3px 8px;font-size:0.8rem;height:30px;"
             placeholder="Start">
      <span style="color:#64748b;font-size:0.8rem;">→</span>
      <input type="datetime-local" [(ngModel)]="customEnd"
             style="background:#1a1d27;border:1px solid #3d4460;border-radius:6px;color:#e2e8f0;padding:3px 8px;font-size:0.8rem;height:30px;"
             placeholder="End">

      <!-- Apply -->
      <button mat-flat-button color="primary"
              style="height:30px;line-height:30px;font-size:0.78rem;padding:0 12px;min-width:0;"
              (click)="applyCustom()"
              [disabled]="!customStart && !customEnd">
        <mat-icon style="font-size:16px;width:16px;height:16px;margin-right:4px;">check</mat-icon>Apply
      </button>

      <!-- Clear -->
      <button mat-stroked-button color="warn"
              style="height:30px;line-height:30px;font-size:0.78rem;padding:0 10px;min-width:0;"
              *ngIf="hasFilter()"
              (click)="clear()">
        <mat-icon style="font-size:16px;width:16px;height:16px;margin-right:4px;">clear</mat-icon>Clear
      </button>

      <!-- Active label -->
      <span *ngIf="hasFilter()" style="font-size:0.75rem;color:#6366f1;margin-left:0.25rem;">
        <mat-icon style="font-size:14px;width:14px;height:14px;vertical-align:middle;">schedule</mat-icon>
        {{ activeLabel() }}
      </span>
    </div>
  `,
  styles: [`
    .active-preset { background: rgba(99,102,241,0.2) !important; color: #818cf8 !important; border-color: #6366f1 !important; }
  `],
})
export class TimeFilterComponent {
  @Output() filterChange = new EventEmitter<TimeFilter>();

  presets = [
    { key: 'day',   label: 'Last Day',   hours: 24 },
    { key: 'week',  label: 'Last Week',  hours: 168 },
    { key: 'month', label: 'Last Month', hours: 720 },
  ];

  customStart = '';
  customEnd   = '';
  activePreset = signal<string>('');
  private _filter = signal<TimeFilter>({ start: null, end: null });

  activeLabel = computed(() => {
    const f = this._filter();
    if (!f.start && !f.end) return '';
    if (f.label) return f.label;
    const s = f.start ? f.start.replace('T', ' ').slice(0, 16) : '…';
    const e = f.end   ? f.end.replace('T', ' ').slice(0, 16)   : 'now';
    return `${s} → ${e}`;
  });

  hasFilter(): boolean {
    const f = this._filter();
    return !!(f.start || f.end);
  }

  applyPreset(preset: { key: string; label: string; hours: number }) {
    this.activePreset.set(preset.key);
    const end   = new Date();
    const start = new Date(end.getTime() - preset.hours * 3600 * 1000);
    const filter: TimeFilter = {
      start: toLocalISOString(start),
      end:   toLocalISOString(end),
      label: preset.label,
    };
    this._filter.set(filter);
    this.customStart = filter.start ? filter.start.replace('T', ' ') : '';
    this.customEnd   = filter.end   ? filter.end.replace('T', ' ')   : '';
    this.filterChange.emit(filter);
  }

  applyCustom() {
    if (!this.customStart && !this.customEnd) return;
    this.activePreset.set('');
    const filter: TimeFilter = {
      start: this.customStart ? this.customStart.replace('T', ' ') : null,
      end:   this.customEnd   ? this.customEnd.replace('T', ' ')   : null,
    };
    this._filter.set(filter);
    this.filterChange.emit(filter);
  }

  clear() {
    this.customStart = '';
    this.customEnd   = '';
    this.activePreset.set('');
    this._filter.set({ start: null, end: null });
    this.filterChange.emit({ start: null, end: null });
  }

  /** Programmatically set filter from parent (e.g. on page load) */
  setFilter(f: TimeFilter) {
    this._filter.set(f);
    if (f.start) this.customStart = f.start.replace(' ', 'T');
    if (f.end)   this.customEnd   = f.end.replace(' ', 'T');
  }
}

function toLocalISOString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

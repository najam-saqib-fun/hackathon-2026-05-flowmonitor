import {
  Component, EventEmitter, Output, signal, computed, OnInit
} from '@angular/core';
import { NgIf, NgFor, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

export interface TimeFilter {
  start: string | null;
  end: string | null;
  label?: string;
}

const PRESETS = [
  { key: 'hour',  label: 'Last Hour',  hours: 1 },
  { key: 'day',   label: 'Last Day',   hours: 24 },
  { key: 'week',  label: 'Last Week',  hours: 168 },
  { key: 'month', label: 'Last Month', hours: 720 },
  { key: 'year',  label: 'Last Year',  hours: 8760 },
];

@Component({
  selector: 'app-time-filter',
  standalone: true,
  imports: [
    NgIf, NgFor, NgClass, FormsModule,
    MatButtonModule, MatIconModule,
    MatSelectModule, MatFormFieldModule, MatInputModule,
  ],
  template: `
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:0.5rem;background:#12151e;border:1px solid #2d3148;border-radius:10px;padding:0.6rem 1rem;">

      <!-- Mode buttons -->
      <button mat-stroked-button
              [ngClass]="mode() === 'quick' ? 'active-preset' : ''"
              style="height:30px;line-height:30px;font-size:0.78rem;padding:0 12px;min-width:0;"
              (click)="setMode('quick')">
        <mat-icon style="font-size:15px;width:15px;height:15px;margin-right:4px;vertical-align:middle;">bolt</mat-icon>Quick
      </button>
      <button mat-stroked-button
              [ngClass]="mode() === 'custom' ? 'active-preset' : ''"
              style="height:30px;line-height:30px;font-size:0.78rem;padding:0 12px;min-width:0;"
              (click)="setMode('custom')">
        <mat-icon style="font-size:15px;width:15px;height:15px;margin-right:4px;vertical-align:middle;">date_range</mat-icon>Custom
      </button>

      <div style="width:1px;height:24px;background:#2d3148;margin:0 0.25rem;"></div>

      <!-- Quick mode: preset dropdown -->
      <ng-container *ngIf="mode() === 'quick'">
        <select [(ngModel)]="selectedPresetKey" (ngModelChange)="onPresetSelect($event)"
                style="background:#1a1d27;border:1px solid #3d4460;border-radius:6px;color:#e2e8f0;padding:3px 10px;font-size:0.82rem;height:30px;cursor:pointer;outline:none;">
          <option *ngFor="let p of presets" [value]="p.key">{{ p.label }}</option>
        </select>
      </ng-container>

      <!-- Custom mode: date range pickers -->
      <ng-container *ngIf="mode() === 'custom'">
        <input type="datetime-local" [(ngModel)]="customStart"
               style="background:#1a1d27;border:1px solid #3d4460;border-radius:6px;color:#e2e8f0;padding:3px 8px;font-size:0.8rem;height:30px;">
        <span style="color:#64748b;font-size:0.8rem;">→</span>
        <input type="datetime-local" [(ngModel)]="customEnd"
               style="background:#1a1d27;border:1px solid #3d4460;border-radius:6px;color:#e2e8f0;padding:3px 8px;font-size:0.8rem;height:30px;">
        <button mat-flat-button color="primary"
                style="height:30px;line-height:30px;font-size:0.78rem;padding:0 12px;min-width:0;"
                (click)="applyCustom()"
                [disabled]="!customStart && !customEnd">
          Apply
        </button>
      </ng-container>

      <!-- Active label -->
      <span *ngIf="activeLabel()" style="font-size:0.75rem;color:#6366f1;margin-left:0.25rem;">
        <mat-icon style="font-size:14px;width:14px;height:14px;vertical-align:middle;">schedule</mat-icon>
        {{ activeLabel() }}
      </span>
    </div>
  `,
  styles: [`
    .active-preset { background: rgba(99,102,241,0.2) !important; color: #818cf8 !important; border-color: #6366f1 !important; }
  `],
})
export class TimeFilterComponent implements OnInit {
  @Output() filterChange = new EventEmitter<TimeFilter>();

  presets = PRESETS;
  mode = signal<'quick' | 'custom'>('quick');
  selectedPresetKey = 'week';

  customStart = '';
  customEnd   = '';
  private _filter = signal<TimeFilter>({ start: null, end: null });

  activeLabel = computed(() => {
    const f = this._filter();
    if (!f.start && !f.end) return '';
    if (f.label) return f.label;
    const s = f.start ? f.start.slice(0, 16) : '…';
    const e = f.end   ? f.end.slice(0, 16)   : 'now';
    return `${s} → ${e}`;
  });

  ngOnInit() {
    // Auto-apply default preset (Last Week) on mount
    this.applyPresetByKey('week');
  }

  setMode(m: 'quick' | 'custom') {
    this.mode.set(m);
    if (m === 'custom') {
      // Initialise custom fields from current filter
      const f = this._filter();
      if (f.start) this.customStart = f.start.replace(' ', 'T');
      if (f.end)   this.customEnd   = f.end.replace(' ', 'T');
    } else {
      this.applyPresetByKey(this.selectedPresetKey);
    }
  }

  onPresetSelect(key: string) {
    this.applyPresetByKey(key);
  }

  applyPresetByKey(key: string) {
    const preset = this.presets.find(p => p.key === key);
    if (!preset) return;
    this.selectedPresetKey = key;
    const now   = new Date();
    const start = new Date(now.getTime() - preset.hours * 3_600_000);
    // end is intentionally omitted for presets — the window always ends at "now".
    // Sending a truncated end timestamp would exclude flows that finalized within
    // the current minute (end_time > truncated_now), causing Total Bytes to oscillate
    // as active flows finalize and drop out of the filtered result.
    const filter: TimeFilter = {
      start: toLocal(start),
      end:   null,
      label: preset.label,
    };
    this._filter.set(filter);
    // Keep custom fields in sync so switching to Custom shows sensible values
    this.customStart = filter.start!.replace(' ', 'T');
    this.customEnd   = toLocal(now).replace(' ', 'T');
    this.filterChange.emit(filter);
  }

  applyCustom() {
    if (!this.customStart && !this.customEnd) return;
    const filter: TimeFilter = {
      start: this.customStart ? this.customStart.replace('T', ' ') : null,
      end:   this.customEnd   ? this.customEnd.replace('T', ' ')   : null,
    };
    this._filter.set(filter);
    this.filterChange.emit(filter);
  }

  /** Programmatically set filter from parent */
  setFilter(f: TimeFilter) {
    this._filter.set(f);
    if (f.start) this.customStart = f.start.replace(' ', 'T');
    if (f.end)   this.customEnd   = f.end.replace(' ', 'T');
  }
}

function toLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

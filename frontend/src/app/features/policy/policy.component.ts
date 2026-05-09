import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { NgIf, NgFor, NgClass, DecimalPipe } from '@angular/common';
import { FormControl, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { debounceTime, distinctUntilChanged, switchMap, of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';

interface PolicyRow {
  application: string;
  category:    string;
  total_flows: number;
  total_bytes: number;
  enabled:     number;
  _enabled:    boolean;
  _custom?:    boolean;
}

@Component({
  selector: 'app-policy',
  standalone: true,
  imports: [
    NgIf, NgFor, NgClass, DecimalPipe, FormsModule, ReactiveFormsModule,
    MatTableModule, MatButtonModule, MatIconModule,
    MatSlideToggleModule, MatSnackBarModule,
    MatProgressSpinnerModule, MatTooltipModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatAutocompleteModule,
  ],
  template: `
    <div class="page-header">Capture Policy</div>

    <div class="info-banner">
      <mat-icon style="color:#818cf8;font-size:1.1rem;height:1.1rem;width:1.1rem;flex-shrink:0;">info</mat-icon>
      <span>
        Applications <strong>disabled</strong> here will not be stored to the database.
        The flow monitor picks up changes every sync interval (~30 s).
        Any application not listed here is <strong>allowed by default</strong>.
      </span>
    </div>

    <!-- ── Add Rule card ────────────────────────────────────── -->
    <div *ngIf="isAdmin" class="card add-card">
      <div class="card-title" style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.6rem;">
        <mat-icon style="color:#818cf8;font-size:1.1rem;height:1.1rem;width:1.1rem;">add_circle</mat-icon>
        Add / Override Rule
      </div>
      <div style="font-size:0.82rem;color:#64748b;margin-bottom:0.85rem;">
        Type an application name to allow or block it. Suggestions come from your application mappings.
      </div>

      <div style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:flex-start;">
        <mat-form-field appearance="outline" style="width:300px;">
          <mat-label>Application name</mat-label>
          <input matInput
                 [formControl]="appCtrl"
                 [matAutocomplete]="auto"
                 placeholder="e.g. YouTube, TLS, Netflix…">
          <mat-autocomplete #auto="matAutocomplete">
            <mat-option *ngFor="let opt of suggestions()" [value]="opt">{{ opt }}</mat-option>
          </mat-autocomplete>
          <mat-hint>Start typing — shows apps from your mappings</mat-hint>
        </mat-form-field>

        <div style="display:flex;gap:0.5rem;padding-bottom:1.25rem;">
          <button mat-flat-button color="primary"
                  [disabled]="!appCtrl.value?.trim() || adding()"
                  (click)="addRule(true)">
            <mat-spinner *ngIf="adding() === 'allow'" diameter="16" style="display:inline-block;margin-right:6px;"></mat-spinner>
            <mat-icon *ngIf="adding() !== 'allow'">check_circle</mat-icon>
            Allow
          </button>
          <button mat-flat-button color="warn"
                  [disabled]="!appCtrl.value?.trim() || adding()"
                  (click)="addRule(false)">
            <mat-spinner *ngIf="adding() === 'block'" diameter="16" style="display:inline-block;margin-right:6px;"></mat-spinner>
            <mat-icon *ngIf="adding() !== 'block'">block</mat-icon>
            Block
          </button>
        </div>
      </div>
    </div>

    <!-- ── Toolbar ──────────────────────────────────────────── -->
    <div class="toolbar-row">
      <mat-form-field appearance="outline" style="width:240px;flex-shrink:0;">
        <mat-label>Search</mat-label>
        <input matInput [(ngModel)]="searchText" placeholder="Filter by name…">
        <mat-icon matSuffix style="color:#64748b;">search</mat-icon>
      </mat-form-field>

      <mat-form-field appearance="outline" style="width:170px;flex-shrink:0;">
        <mat-label>Category</mat-label>
        <mat-select [(ngModel)]="filterCategory">
          <mat-option value="">All</mat-option>
          <mat-option *ngFor="let c of categories()" [value]="c">{{ c }}</mat-option>
        </mat-select>
      </mat-form-field>

      <div style="flex:1;"></div>

      <button *ngIf="isAdmin" mat-stroked-button (click)="enableAll()"
              matTooltip="Enable capture for all applications in the list">
        <mat-icon>check_circle</mat-icon> Enable All
      </button>
      <button *ngIf="isAdmin" mat-stroked-button (click)="disableAll()"
              matTooltip="Disable capture for all applications in the list">
        <mat-icon>block</mat-icon> Disable All
      </button>
    </div>

    <!-- ── Summary chips ──────────────────────────────────────── -->
    <div *ngIf="!loading()" class="summary-row">
      <div class="summary-chip enabled-chip">
        <mat-icon style="font-size:1rem;height:1rem;width:1rem;">check_circle</mat-icon>
        {{ enabledCount() }} Enabled
      </div>
      <div class="summary-chip disabled-chip">
        <mat-icon style="font-size:1rem;height:1rem;width:1rem;">block</mat-icon>
        {{ disabledCount() }} Disabled
      </div>
      <div class="summary-chip total-chip">
        <mat-icon style="font-size:1rem;height:1rem;width:1rem;">list</mat-icon>
        {{ filteredRows().length }} shown
      </div>
      <div *ngIf="dirty()" class="summary-chip dirty-chip">
        <mat-icon style="font-size:1rem;height:1rem;width:1rem;">edit</mat-icon>
        {{ dirtyCount() }} unsaved
      </div>
    </div>

    <!-- ── Table ──────────────────────────────────────────────── -->
    <div class="card" style="overflow:auto;padding:0;">
      <div *ngIf="loading()" style="text-align:center;padding:3rem;">
        <mat-spinner diameter="36" style="margin:auto;"></mat-spinner>
      </div>

      <table *ngIf="!loading()" mat-table [dataSource]="filteredRows()"
             style="width:100%;background:transparent;min-width:660px;">

        <ng-container matColumnDef="application">
          <th mat-header-cell *matHeaderCellDef class="th-cell">Application</th>
          <td mat-cell *matCellDef="let r" style="font-weight:500;font-size:0.88rem;">
            {{ r.application }}
            <span *ngIf="r._custom" class="badge-custom">new</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="category">
          <th mat-header-cell *matHeaderCellDef class="th-cell">Category</th>
          <td mat-cell *matCellDef="let r">
            <span *ngIf="r.category" [ngClass]="'cat-badge cat-' + slugify(r.category)">{{ r.category }}</span>
            <span *ngIf="!r.category" style="color:#475569;font-size:0.82rem;">—</span>
          </td>
        </ng-container>

        <ng-container matColumnDef="total_flows">
          <th mat-header-cell *matHeaderCellDef class="th-cell" style="text-align:right;">Flows</th>
          <td mat-cell *matCellDef="let r" style="text-align:right;font-size:0.85rem;color:#94a3b8;font-variant-numeric:tabular-nums;">
            {{ r._custom ? '—' : (r.total_flows | number) }}
          </td>
        </ng-container>

        <ng-container matColumnDef="total_bytes">
          <th mat-header-cell *matHeaderCellDef class="th-cell" style="text-align:right;">Traffic</th>
          <td mat-cell *matCellDef="let r" style="text-align:right;font-size:0.85rem;color:#94a3b8;">
            {{ r._custom ? '—' : fmtBytes(r.total_bytes) }}
          </td>
        </ng-container>

        <ng-container matColumnDef="capture">
          <th mat-header-cell *matHeaderCellDef class="th-cell" style="text-align:center;">Capture</th>
          <td mat-cell *matCellDef="let r" style="text-align:center;">
            <mat-slide-toggle *ngIf="isAdmin" [(ngModel)]="r._enabled" (ngModelChange)="onToggle()"
              color="primary"
              [matTooltip]="r._enabled ? 'Enabled — click to block' : 'Blocked — click to allow'">
            </mat-slide-toggle>
            <span *ngIf="!isAdmin" [style.color]="r._enabled ? '#4ade80' : '#f87171'">
              {{ r._enabled ? 'Allowed' : 'Blocked' }}
            </span>
          </td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="cols" style="background:#12151e;"></tr>
        <tr mat-row *matRowDef="let row; columns: cols;" [ngClass]="{'row-disabled': !row._enabled}"></tr>
      </table>

      <div *ngIf="!loading() && filteredRows().length === 0"
           style="text-align:center;padding:3rem;color:#475569;">
        <mat-icon style="font-size:2rem;height:2rem;width:2rem;display:block;margin:0 auto 0.5rem;">search_off</mat-icon>
        No applications match the current filter.
      </div>
    </div>

    <!-- Sticky Save bar -->
    <div *ngIf="isAdmin" class="save-bar" [ngClass]="{'save-bar-visible': dirty()}">
      <span style="font-size:0.88rem;color:#94a3b8;">
        {{ dirtyCount() }} unsaved change{{ dirtyCount() === 1 ? '' : 's' }}
      </span>
      <div style="display:flex;gap:0.75rem;">
        <button mat-stroked-button (click)="revertChanges()" [disabled]="saving()">
          <mat-icon>undo</mat-icon> Revert
        </button>
        <button mat-flat-button color="primary" (click)="saveChanges()" [disabled]="saving()">
          <mat-spinner *ngIf="saving()" diameter="16" style="display:inline-block;margin-right:6px;"></mat-spinner>
          <mat-icon *ngIf="!saving()">save</mat-icon>
          {{ saving() ? 'Saving…' : 'Save Changes' }}
        </button>
      </div>
    </div>
  `,
  styles: [`
    .info-banner {
      display:flex;align-items:flex-start;gap:.6rem;
      background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.25);
      border-radius:8px;padding:.75rem 1rem;margin-bottom:1.25rem;
      font-size:.87rem;color:#cbd5e1;line-height:1.5;
    }
    .add-card { margin-bottom:1.25rem;border:1px solid rgba(99,102,241,.2); }
    .toolbar-row { display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-bottom:1rem; }
    .summary-row { display:flex;gap:.75rem;flex-wrap:wrap;margin-bottom:1.25rem; }
    .summary-chip { display:flex;align-items:center;gap:.35rem;padding:.35rem .75rem;border-radius:20px;font-size:.82rem;font-weight:500; }
    .enabled-chip  { background:rgba(34,197,94,.12); color:#4ade80;border:1px solid rgba(34,197,94,.25); }
    .disabled-chip { background:rgba(248,113,113,.12);color:#f87171;border:1px solid rgba(248,113,113,.25);}
    .total-chip    { background:rgba(148,163,184,.08);color:#94a3b8;border:1px solid rgba(148,163,184,.15);}
    .dirty-chip    { background:rgba(251,191,36,.12); color:#fbbf24;border:1px solid rgba(251,191,36,.25); }
    .badge-custom  { margin-left:6px;padding:1px 6px;border-radius:10px;font-size:.68rem;font-weight:600;
                     text-transform:uppercase;background:rgba(251,191,36,.15);color:#fbbf24;
                     border:1px solid rgba(251,191,36,.3);vertical-align:middle; }
    .th-cell { color:#64748b;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em; }
    .row-disabled td { opacity:.45; }
    .cat-badge { display:inline-block;padding:2px 8px;border-radius:12px;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em; }
    .cat-streaming{background:rgba(99,102,241,.15);color:#818cf8}
    .cat-social{background:rgba(236,72,153,.15);color:#f472b6}
    .cat-productivity{background:rgba(34,197,94,.15);color:#4ade80}
    .cat-messaging{background:rgba(59,130,246,.15);color:#60a5fa}
    .cat-gaming{background:rgba(251,191,36,.15);color:#fbbf24}
    .cat-web{background:rgba(20,184,166,.15);color:#2dd4bf}
    .cat-cloud{background:rgba(168,85,247,.15);color:#c084fc}
    .cat-other{background:rgba(148,163,184,.1);color:#94a3b8}
    .save-bar { position:fixed;bottom:-80px;left:0;right:0;background:#1e2235;
      border-top:1px solid #2d3148;display:flex;align-items:center;
      justify-content:flex-end;gap:1rem;padding:.875rem 2rem;z-index:100;
      transition:bottom .25s ease;box-shadow:0 -4px 20px rgba(0,0,0,.35); }
    .save-bar-visible { bottom:0; }
  `],
})
export class PolicyComponent implements OnInit {
  private api   = inject(ApiService);
  private snack = inject(MatSnackBar);
  private auth  = inject(AuthService);

  isAdmin = false;

  cols    = ['application', 'category', 'total_flows', 'total_bytes', 'capture'];
  rows    = signal<PolicyRow[]>([]);
  loading = signal(false);
  saving  = signal(false);
  adding  = signal<'allow' | 'block' | null>(null);

  searchText     = '';
  filterCategory = '';

  // Autocomplete
  appCtrl     = new FormControl('');
  suggestions = signal<string[]>([]);

  categories = computed(() =>
    [...new Set(this.rows().map(r => r.category).filter(Boolean))].sort()
  );

  filteredRows = computed(() => {
    const s   = this.searchText.trim().toLowerCase();
    const cat = this.filterCategory;
    return this.rows().filter(r =>
      (!s   || r.application.toLowerCase().includes(s)) &&
      (!cat || r.category === cat)
    );
  });

  ngOnInit() {
    this.isAdmin = this.auth.currentUser?.role === 'admin';
    this.load();
    // Wire autocomplete: debounce keystrokes, fetch matching app names
    this.appCtrl.valueChanges.pipe(
      debounceTime(200),
      distinctUntilChanged(),
      switchMap(q => q && q.trim().length >= 1
        ? this.api.getMappingApplications(q.trim())
        : of([])
      ),
    ).subscribe(names => this.suggestions.set(names));
  }

  private load() {
    this.loading.set(true);
    this.api.getPolicy().subscribe({
      next: (data: any[]) => {
        this.rows.set(data.map(r => ({ ...r, _enabled: !!r.enabled })));
        this.loading.set(false);
      },
      error: () => {
        this.snack.open('Failed to load policy', 'OK', { duration: 4000 });
        this.loading.set(false);
      },
    });
  }

  onToggle() { this.rows.set([...this.rows()]); }

  enableAll()  { this.rows.set(this.rows().map(r => ({ ...r, _enabled: true  }))); }
  disableAll() { this.rows.set(this.rows().map(r => ({ ...r, _enabled: false }))); }

  /** Immediately saves a single allow/block rule to the DB, then refreshes the list. */
  addRule(allow: boolean) {
    const name = (this.appCtrl.value || '').trim();
    if (!name) return;

    this.adding.set(allow ? 'allow' : 'block');
    this.api.updatePolicyBulk([{ application: name, enabled: allow ? 1 : 0 }]).subscribe({
      next: () => {
        this.adding.set(null);
        this.appCtrl.setValue('');
        this.suggestions.set([]);
        this.snack.open(`"${name}" ${allow ? 'allowed' : 'blocked'} and saved`, 'OK', { duration: 3000 });
        this.load(); // refresh table to show the new/updated row
      },
      error: err => {
        this.adding.set(null);
        this.snack.open('Error: ' + (err.error?.error || err.message), 'OK', { duration: 4000 });
      },
    });
  }

  enabledCount()  { return this.rows().filter(r =>  r._enabled).length; }
  disabledCount() { return this.rows().filter(r => !r._enabled).length; }
  dirty()         { return this.rows().some(r => r._enabled !== !!r.enabled); }
  dirtyCount()    { return this.rows().filter(r => r._enabled !== !!r.enabled).length; }

  revertChanges() {
    this.rows.set(this.rows()
      .filter(r => !r._custom)
      .map(r => ({ ...r, _enabled: !!r.enabled }))
    );
  }

  saveChanges() {
    const updates = this.rows()
      .filter(r => r._enabled !== !!r.enabled)
      .map(r => ({ application: r.application, enabled: r._enabled ? 1 : 0 }));
    if (!updates.length) return;
    this.saving.set(true);
    this.api.updatePolicyBulk(updates).subscribe({
      next: () => {
        this.rows.set(this.rows().map(r => ({ ...r, enabled: r._enabled ? 1 : 0, _custom: false })));
        this.saving.set(false);
        this.snack.open(`Policy saved — ${updates.length} app${updates.length === 1 ? '' : 's'} updated`, 'OK', { duration: 3500 });
      },
      error: err => {
        this.saving.set(false);
        this.snack.open('Error: ' + (err.error?.error || err.message), 'OK', { duration: 4000 });
      },
    });
  }

  slugify(cat: string): string {
    const c = (cat || '').toLowerCase();
    if (c.includes('stream'))              return 'streaming';
    if (c.includes('social'))              return 'social';
    if (c.includes('product'))             return 'productivity';
    if (c.includes('messag')||c.includes('chat')) return 'messaging';
    if (c.includes('gam'))                 return 'gaming';
    if (c.includes('web'))                 return 'web';
    if (c.includes('cloud'))               return 'cloud';
    return 'other';
  }

  fmtBytes(bytes: number): string {
    if (!bytes) return '0 B';
    const u = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const v = bytes / Math.pow(1024, i);
    return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0)} ${u[i]}`;
  }
}

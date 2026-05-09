import { Component, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { NgIf, NgFor, DatePipe, DecimalPipe } from '@angular/common';
import { FormBuilder, Validators, ReactiveFormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatCardModule } from '@angular/material/card';
import { MatTabsModule } from '@angular/material/tabs';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { WebSocketService } from '../../core/services/websocket.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-alerts',
  standalone: true,
  imports: [
    NgIf, NgFor, DatePipe, DecimalPipe,
    ReactiveFormsModule,
    MatTableModule, MatButtonModule, MatIconModule,
    MatFormFieldModule, MatInputModule, MatSelectModule,
    MatSlideToggleModule, MatSnackBarModule, MatCardModule,
    MatTabsModule,
  ],
  template: `
    <div class="page-header">Alert Management</div>

    <mat-tab-group>
      <!-- Rules -->
      <mat-tab label="Alert Rules">
        <div style="padding-top:1rem;">
          <!-- Create rule form -->
          <div *ngIf="isAdmin" class="card" style="margin-bottom:1rem;" [formGroup]="ruleForm">
            <div class="card-title">New Alert Rule</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0.75rem;">
              <mat-form-field appearance="outline">
                <mat-label>Rule Name</mat-label>
                <input matInput formControlName="name">
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Metric</mat-label>
                <mat-select formControlName="metric">
                  <mat-option value="bytes_per_sec">Bytes/sec</mat-option>
                  <mat-option value="flows_per_min">Flows/min</mat-option>
                  <mat-option value="conn_per_ip">Connections per IP</mat-option>
                  <mat-option value="unusual_port">Unusual Port</mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Threshold</mat-label>
                <input matInput type="number" formControlName="threshold">
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Window (seconds)</mat-label>
                <input matInput type="number" formControlName="window_seconds">
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Application (optional)</mat-label>
                <input matInput formControlName="application" placeholder="e.g. YouTube">
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Source IP (optional)</mat-label>
                <input matInput formControlName="src_ip">
              </mat-form-field>
            </div>
            <button mat-flat-button color="primary" (click)="createRule()" [disabled]="ruleForm.invalid" style="margin-top:0.5rem;">
              <mat-icon>add</mat-icon> Create Rule
            </button>
          </div>

          <!-- Rules table -->
          <div class="card">
            <table mat-table [dataSource]="rules()" style="width:100%;background:transparent;">
              <ng-container matColumnDef="name">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Name</th>
                <td mat-cell *matCellDef="let r" style="font-weight:500;">{{ r.name }}</td>
              </ng-container>
              <ng-container matColumnDef="metric">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Metric</th>
                <td mat-cell *matCellDef="let r"><span class="badge badge-tcp">{{ r.metric }}</span></td>
              </ng-container>
              <ng-container matColumnDef="threshold">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Threshold</th>
                <td mat-cell *matCellDef="let r">{{ r.threshold | number }}</td>
              </ng-container>
              <ng-container matColumnDef="window">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Window</th>
                <td mat-cell *matCellDef="let r">{{ r.window_seconds }}s</td>
              </ng-container>
              <ng-container matColumnDef="app">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Application</th>
                <td mat-cell *matCellDef="let r">{{ r.application || '—' }}</td>
              </ng-container>
              <ng-container matColumnDef="enabled">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Enabled</th>
                <td mat-cell *matCellDef="let r">
                  <mat-slide-toggle *ngIf="isAdmin" [checked]="r.enabled" (change)="toggleRule(r, $event.checked)"></mat-slide-toggle>
                  <span *ngIf="!isAdmin" [style.color]="r.enabled ? '#22c55e' : '#f87171'">{{ r.enabled ? 'Yes' : 'No' }}</span>
                </td>
              </ng-container>
              <ng-container matColumnDef="actions">
                <th mat-header-cell *matHeaderCellDef></th>
                <td mat-cell *matCellDef="let r">
                  <button *ngIf="isAdmin" mat-icon-button color="warn" (click)="deleteRule(r.id)" matTooltip="Delete">
                    <mat-icon>delete</mat-icon>
                  </button>
                </td>
              </ng-container>
              <tr mat-header-row *matHeaderRowDef="ruleCols"></tr>
              <tr mat-row *matRowDef="let row; columns: ruleCols;"></tr>
            </table>
            <div *ngIf="!rules().length" style="color:#475569;padding:1rem;text-align:center;">No alert rules configured.</div>
          </div>
        </div>
      </mat-tab>

      <!-- Events -->
      <mat-tab label="Alert Events">
        <div style="padding-top:1rem;">
          <div class="card">
            <div style="display:flex;gap:0.75rem;margin-bottom:1rem;">
              <button mat-stroked-button (click)="loadEvents(false)">Unacknowledged</button>
              <button mat-stroked-button (click)="loadEvents(true)">All</button>
            </div>
            <table mat-table [dataSource]="events()" style="width:100%;background:transparent;">
              <ng-container matColumnDef="time">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Triggered</th>
                <td mat-cell *matCellDef="let e" style="font-size:0.85rem;color:#94a3b8;">{{ e.triggered_at | date:'MM/dd HH:mm:ss' }}</td>
              </ng-container>
              <ng-container matColumnDef="rule">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Rule</th>
                <td mat-cell *matCellDef="let e" style="font-weight:500;">{{ e.rule_name }}</td>
              </ng-container>
              <ng-container matColumnDef="metric">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Metric</th>
                <td mat-cell *matCellDef="let e">{{ e.metric }}</td>
              </ng-container>
              <ng-container matColumnDef="value">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Value</th>
                <td mat-cell *matCellDef="let e"><span class="badge badge-danger">{{ e.metric_value | number:'1.0-2' }}</span></td>
              </ng-container>
              <ng-container matColumnDef="ack">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Status</th>
                <td mat-cell *matCellDef="let e">
                  <span *ngIf="e.acknowledged" class="badge badge-success">ACK</span>
                  <button *ngIf="!e.acknowledged && isOperator" mat-stroked-button color="accent" style="font-size:0.75rem;height:28px;line-height:28px;" (click)="ack(e)">
                    Acknowledge
                  </button>
                  <span *ngIf="!e.acknowledged && !isOperator" style="color:#64748b;font-size:0.8rem;">Pending</span>
                </td>
              </ng-container>
              <tr mat-header-row *matHeaderRowDef="eventCols"></tr>
              <tr mat-row *matRowDef="let row; columns: eventCols;"></tr>
            </table>
            <div *ngIf="!events().length" style="color:#475569;padding:1rem;text-align:center;">No alert events.</div>
          </div>
        </div>
      </mat-tab>
    </mat-tab-group>
  `,
})
export class AlertsComponent implements OnInit, OnDestroy {
  private api     = inject(ApiService);
  private snack   = inject(MatSnackBar);
  private ws      = inject(WebSocketService);
  private fb      = inject(FormBuilder);
  private auth    = inject(AuthService);
  private alertSub?: Subscription;

  isAdmin    = false;
  isOperator = false;
  rules  = signal<any[]>([]);
  events = signal<any[]>([]);
  ruleCols  = ['name', 'metric', 'threshold', 'window', 'app', 'enabled', 'actions'];
  eventCols = ['time', 'rule', 'metric', 'value', 'ack'];

  ruleForm = this.fb.group({
    name: ['', Validators.required],
    metric: ['bytes_per_sec', Validators.required],
    threshold: [null as number | null, [Validators.required, Validators.min(0)]],
    window_seconds: [60],
    application: [''],
    src_ip: [''],
  });

  ngOnInit() {
    const role = this.auth.currentUser?.role;
    this.isAdmin    = role === 'admin';
    this.isOperator = role === 'admin' || role === 'operator';
    this.loadRules();
    this.loadEvents(false);
    this.alertSub = this.ws.alert$.subscribe(alert => {
      this.snack.open(`🔔 Alert: ${alert.data.rule_name} — value ${alert.data.value?.toFixed(2)}`, 'Dismiss', { duration: 8000 });
      this.loadEvents(false);
    });
  }

  ngOnDestroy() { this.alertSub?.unsubscribe(); }

  loadRules() { this.api.getAlertRules().subscribe(d => this.rules.set(d)); }

  loadEvents(all: boolean) {
    const params = all ? {} : { acknowledged: 0 };
    this.api.getAlertEvents(params).subscribe(d => this.events.set(d));
  }

  createRule() {
    if (this.ruleForm.invalid) return;
    const val = this.ruleForm.getRawValue();
    this.api.createAlertRule(val).subscribe({
      next: () => { this.snack.open('Rule created', 'OK', { duration: 3000 }); this.loadRules(); this.ruleForm.reset({ metric: 'bytes_per_sec', window_seconds: 60 }); },
      error: err => this.snack.open('Error: ' + (err.error?.error || err.message), 'OK', { duration: 4000 }),
    });
  }

  deleteRule(id: number) {
    this.api.deleteAlertRule(id).subscribe(() => this.loadRules());
  }

  toggleRule(rule: any, enabled: boolean) {
    this.api.updateAlertRule(rule.id, { enabled: enabled ? 1 : 0 }).subscribe(() => this.loadRules());
  }

  ack(event: any) {
    this.api.acknowledgeAlert(event.id).subscribe(() => this.loadEvents(false));
  }
}

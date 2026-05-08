import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  // ── Flows ─────────────────────────────────────────────────────────────────
  getFlows(params: Record<string, any> = {}) {
    return this.http.get<any>(`${this.base}/flows`, { params: this.toParams(params) });
  }
  getLiveFlows(seconds = 30) {
    return this.http.get<any[]>(`${this.base}/flows/live`, { params: { seconds } });
  }
  getFlow(id: number) {
    return this.http.get<any>(`${this.base}/flows/${id}`);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  getOverview(params: Record<string, any> = {}) {
    return this.http.get<any>(`${this.base}/stats/overview`, { params: this.toParams(params) });
  }
  getTopApps(params: Record<string, any> = {}) {
    return this.http.get<any[]>(`${this.base}/stats/top-apps`, { params: this.toParams(params) });
  }
  getTopTalkers(params: Record<string, any> = {}) {
    return this.http.get<any>(`${this.base}/stats/top-talkers`, { params: this.toParams(params) });
  }
  getBandwidth(params: Record<string, any> = {}) {
    return this.http.get<any[]>(`${this.base}/stats/bandwidth`, { params: this.toParams(params) });
  }
  getAppUsage(params: Record<string, any> = {}) {
    return this.http.get<any[]>(`${this.base}/stats/app-usage`, { params: this.toParams(params) });
  }
  getProtocolDist(params: Record<string, any> = {}) {
    return this.http.get<any[]>(`${this.base}/stats/protocol-distribution`, { params: this.toParams(params) });
  }
  getHistory(period: 'hourly' | 'daily' | 'monthly' = 'hourly') {
    return this.http.get<any[]>(`${this.base}/stats/history`, { params: { period } });
  }
  getAnomalies() {
    return this.http.get<any>(`${this.base}/stats/anomalies`);
  }
  getAppDetection() {
    return this.http.get<any>(`${this.base}/stats/app-detection`);
  }

  // ── Alerts ────────────────────────────────────────────────────────────────
  getAlertRules() { return this.http.get<any[]>(`${this.base}/alerts/rules`); }
  createAlertRule(rule: any) { return this.http.post<any>(`${this.base}/alerts/rules`, rule); }
  updateAlertRule(id: number, rule: any) { return this.http.put<any>(`${this.base}/alerts/rules/${id}`, rule); }
  deleteAlertRule(id: number) { return this.http.delete<any>(`${this.base}/alerts/rules/${id}`); }
  getAlertEvents(params: Record<string, any> = {}) {
    return this.http.get<any[]>(`${this.base}/alerts/events`, { params: this.toParams(params) });
  }
  acknowledgeAlert(id: number) { return this.http.post<any>(`${this.base}/alerts/events/${id}/acknowledge`, {}); }

  // ── Domains ───────────────────────────────────────────────────────────────
  getDomains(params: Record<string, any> = {}) {
    return this.http.get<any>(`${this.base}/domains`, { params: this.toParams(params) });
  }
  getDomainsChart(params: Record<string, any> = {}) {
    return this.http.get<any[]>(`${this.base}/domains/chart`, { params: this.toParams(params) });
  }
  getDomainUniqueSources() {
    return this.http.get<any[]>(`${this.base}/domains/unique-sources`);
  }

  // ── Application Mappings ──────────────────────────────────────────────────
  getMappings(params: Record<string, any> = {}) {
    return this.http.get<any>(`${this.base}/mappings`, { params: this.toParams(params) });
  }
  createMapping(m: any) { return this.http.post<any>(`${this.base}/mappings`, m); }
  updateMapping(id: number, m: any) { return this.http.put<any>(`${this.base}/mappings/${id}`, m); }
  deleteMapping(id: number) { return this.http.delete<any>(`${this.base}/mappings/${id}`); }
  importMappings(format: string, data: string) {
    return this.http.post<any>(`${this.base}/mappings/import`, { format, data });
  }
  exportMappingsUrl(format: 'csv' | 'json') {
    return `${this.base}/mappings/export?format=${format}`;
  }

  // ── IPDR Keys ─────────────────────────────────────────────────────────────
  getIpdrKeys(params: Record<string, any> = {}) {
    return this.http.get<any>(`${this.base}/ipdr`, { params: this.toParams(params) });
  }
  getIpdrFlows(id: number) {
    return this.http.get<any>(`${this.base}/ipdr/${id}/flows`);
  }

  // ── Subscribers ───────────────────────────────────────────────────────────
  getSubscribers(params: Record<string, any> = {}) {
    return this.http.get<any>(`${this.base}/subscribers`, { params: this.toParams(params) });
  }
  createSubscriber(s: any) { return this.http.post<any>(`${this.base}/subscribers`, s); }
  updateSubscriber(id: number, s: any) { return this.http.put<any>(`${this.base}/subscribers/${id}`, s); }
  deleteSubscriber(id: number) { return this.http.delete<any>(`${this.base}/subscribers/${id}`); }
  importSubscribers(format: string, data: string) {
    return this.http.post<any>(`${this.base}/subscribers/import`, { format, data });
  }
  exportSubscribersUrl(format: 'csv' | 'json') {
    return `${this.base}/subscribers/export?format=${format}`;
  }

  // ── Capture Policy ────────────────────────────────────────────────────────
  getPolicy() { return this.http.get<any[]>(`${this.base}/policy`); }
  updatePolicyBulk(updates: { application: string; enabled: number }[]) {
    return this.http.post<any>(`${this.base}/policy/bulk`, { updates });
  }
  getMappingApplications(q: string) {
    return this.http.get<string[]>(`${this.base}/mappings/applications`, { params: { q } });
  }

  private toParams(obj: Record<string, any>): HttpParams {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && v !== undefined && v !== '') p = p.set(k, String(v));
    }
    return p;
  }
}

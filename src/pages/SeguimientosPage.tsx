import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tarea, TareaCreateInput, TareaEvento, TareaListQuery, TareaPrioridad, TareaTipo } from '../types/tarea';
import {
  buildTaskQuery,
  canonicalNow,
  canonicalToDatetimeLocal,
  createHistoryRequestGuard,
  createLatestRequestGuard,
  createSeguimientosClient,
  datetimeLocalToCanonical,
  friendlyTaskDate,
  isTaskError,
  normalizedPage,
  SEGUIMIENTO_VIEWS,
  tareaOrigin,
  taskErrorMessage,
  type SeguimientosApi,
  type SeguimientoView,
} from './seguimientosModel';
import './seguimientos.css';
import './seguimientos.visual.css';
import { AlertasOperativasPanel } from './AlertasOperativasPanel';
import type { AlertaOperativa } from '../types/alertaOperativa';
import type { BandejaOperativaRow } from '../types/bandejaOperativa';
import { BandejaOperativaPanel, type BandejaOperativaApi } from './BandejaOperativaPanel';

const TYPES: Array<[TareaTipo, string]> = [['LLAMAR', 'Llamar'], ['ENVIAR_CORREO', 'Enviar correo'], ['VISITAR', 'Visitar'], ['REVISAR_PROMESA', 'Revisar promesa'], ['REVISAR_DOCUMENTOS', 'Revisar documentos'], ['SEGUIMIENTO_GENERAL', 'Seguimiento general']];
const PRIORITIES: TareaPrioridad[] = ['ALTA', 'MEDIA', 'BAJA'];
const VIEW_LABELS: Record<SeguimientoView, string> = { HOY: 'Hoy', VENCIDA: 'Vencidas', PROXIMA: 'Próximas', COMPLETADA: 'Completadas', TODAS: 'Todas' };
type FormState = { cliente: string; promesaId:number|null; tipo: TareaTipo; titulo: string; descripcion: string; fecha: string; prioridad: TareaPrioridad; responsable: string };
const EMPTY_FORM: FormState = { cliente: '', promesaId:null, tipo: 'LLAMAR', titulo: '', descripcion: '', fecha: '', prioridad: 'MEDIA', responsable: 'sistema' };
const EMPTY_FILTERS = { cliente: '', responsable: '', tipo: '', prioridad: '', estado: '', fechaDesde: '', fechaHasta: '', search: '' };

export function HistoryContent({ loading, error, events }: { loading: boolean; error: string | null; events: TareaEvento[] }) {
  if (loading) return <div className="seguimientos-state">Cargando historial…</div>;
  if (error) return <div className="seguimientos-error" role="alert">{error}</div>;
  if (events.length === 0) return <div className="seguimientos-state">Sin eventos</div>;
  return <>{events.map(event => <div className="seguimientos-event" key={event.id}><strong>{event.tipo_evento.replace(/_/g, ' ')}</strong><div>{event.estado_anterior ?? '—'} → {event.estado_nuevo ?? '—'}</div><div className="seguimientos-event-meta">{friendlyTaskDate(event.fecha)} · {event.actor}</div></div>)}</>;
}

export interface SeguimientosPageProps {
  api?: SeguimientosApi;
  onRegisterGestion?: (cliente: string) => void;
}

export function SeguimientosPage({ api: apiProp, onRegisterGestion }: SeguimientosPageProps) {
  const api = apiProp ?? window.carteraApi;
  const client = useMemo(() => api ? createSeguimientosClient(api) : null, [api]);
  const [view, setView] = useState<SeguimientoView>('HOY');
  const [workspace,setWorkspace]=useState<'BANDEJA'|'TAREAS'|'ALERTAS'>('BANDEJA');
  const [filtersVisible,setFiltersVisible]=useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [items, setItems] = useState<Tarea[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({ HOY: 0, VENCIDA: 0, PROXIMA: 0, COMPLETADA: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Tarea | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const attemptKey = useRef<string | null>(null);
  const [historyTask, setHistoryTask] = useState<Tarea | null>(null);
  const [events, setEvents] = useState<TareaEvento[]>([]);
  const [eventPage, setEventPage] = useState(1);
  const [eventPages, setEventPages] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyGuardRef = useRef(createHistoryRequestGuard());
  const taskOpenGuardRef = useRef(createLatestRequestGuard());
  const historyTaskIdRef = useRef<number | null>(null);
  const eventPageRef = useRef(1);
  const historyOpenRef = useRef(false);
  const requestSequence = useRef(0);

  const queryFilters = useMemo<Omit<TareaListQuery, 'page' | 'pageSize' | 'estado' | 'now'>>(() => ({
    ...(filters.cliente ? { cliente: filters.cliente } : {}),
    ...(filters.responsable ? { responsable: filters.responsable } : {}),
    ...(filters.tipo ? { tipo: filters.tipo as TareaTipo } : {}),
    ...(filters.prioridad ? { prioridad: filters.prioridad as TareaPrioridad } : {}),
    ...(filters.fechaDesde ? { fechaDesde: `${filters.fechaDesde} 00:00:00` } : {}),
    ...(filters.fechaHasta ? { fechaHasta: `${filters.fechaHasta} 23:59:59` } : {}),
    ...(filters.search ? { search: filters.search } : {}),
    ...(filters.estado ? { estado: filters.estado as TareaListQuery['estado'] } : {}),
  }), [filters]);

  const load = useCallback(async () => {
    if (!client) { setError('El módulo de tareas no está disponible.'); setLoading(false); return; }
    const sequence = ++requestSequence.current;
    setLoading(true); setError('');
    try {
      const result = await client.list(buildTaskQuery(view, queryFilters, page, pageSize));
      if (sequence !== requestSequence.current) return;
      if (isTaskError(result)) { setError(taskErrorMessage(result)); setItems([]); setTotal(0); setTotalPages(0); return; }
      const correctedPage = normalizedPage(page, result.totalPages);
      if (correctedPage !== page) { setPage(correctedPage); return; }
      setItems(result.items); setTotal(result.total); setTotalPages(result.totalPages);
    } catch { if (sequence === requestSequence.current) setError('No fue posible cargar los seguimientos.'); }
    finally { if (sequence === requestSequence.current) setLoading(false); }
  }, [client, page, pageSize, queryFilters, view]);

  const loadCounts = useCallback(async () => {
    if (!client) return;
    const now = canonicalNow();
    try {
      const [HOY, VENCIDA, PROXIMA, COMPLETADA] = await Promise.all(['HOY', 'VENCIDA', 'PROXIMA', 'COMPLETADA'].map(state => client.count(state as Exclude<SeguimientoView, 'TODAS'>, now)));
      setCounts({ HOY, VENCIDA, PROXIMA, COMPLETADA });
    } catch { /* La tabla mantiene su error accionable; los KPI quedan neutros. */ }
  }, [client]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadCounts(); }, [loadCounts]);
  useEffect(() => { if (workspace !== 'BANDEJA') taskOpenGuardRef.current.invalidate(); }, [workspace]);
  useEffect(() => () => taskOpenGuardRef.current.invalidate(), []);

  const changeFilter = (key: keyof typeof EMPTY_FILTERS, value: string) => { setFilters(current => ({ ...current, [key]: value })); if (key === 'estado' && value) setView('TODAS'); setPage(1); };
  const selectView = (next: SeguimientoView) => { setView(next); setFilters(current => ({ ...current, estado: '' })); setPage(1); };
  const refresh = async () => { await Promise.all([load(), loadCounts()]); };

  const openCreate = () => { setEditing(null); setForm(EMPTY_FORM); attemptKey.current = crypto.randomUUID(); setShowForm(true); setError(''); };
  const openEdit = (tarea: Tarea) => { setEditing(tarea); setForm({ cliente: tarea.cliente, promesaId:tarea.promesa_id, tipo: tarea.tipo, titulo: tarea.titulo, descripcion: tarea.descripcion ?? '', fecha: canonicalToDatetimeLocal(tarea.fecha_programada), prioridad: tarea.prioridad, responsable: tarea.responsable }); setShowForm(true); setError(''); };
  const createFromAlert=(alerta:AlertaOperativa)=>{setEditing(null);setForm({...EMPTY_FORM,cliente:alerta.cliente,promesaId:alerta.promesa_id,tipo:alerta.promesa_id?'REVISAR_PROMESA':'SEGUIMIENTO_GENERAL',titulo:alerta.promesa_id?'Revisar promesa de pago':'Contactar cliente sin gestión reciente'});attemptKey.current=crypto.randomUUID();setShowForm(true);setError('');};
  const openTaskFromAlert=(alerta:AlertaOperativa)=>{setWorkspace('TAREAS');setView('TODAS');setFilters({...EMPTY_FILTERS,cliente:alerta.cliente});setPage(1);};
  const createFromBandeja=(row:BandejaOperativaRow)=>{if(row.origen==='TAREA')return;setEditing(null);setForm({...EMPTY_FORM,cliente:row.cliente,promesaId:row.origen==='PROMESA'?row.promesa_id:null,tipo:row.origen==='PROMESA'?'REVISAR_PROMESA':'SEGUIMIENTO_GENERAL',titulo:row.origen==='PROMESA'?'Revisar promesa de pago':'Contactar cliente sin gestión reciente'});attemptKey.current=crypto.randomUUID();setShowForm(true);setError('');};
  const openTaskFromBandeja=async(tareaId:number)=>{const token=taskOpenGuardRef.current.begin();if(!api?.tareaObtener){if(taskOpenGuardRef.current.isCurrent(token))setError('No fue posible localizar la tarea.');return;}try{const tarea=await api.tareaObtener(tareaId);if(!taskOpenGuardRef.current.isCurrent(token))return;if(!tarea){setError('La tarea ya no existe.');return;}setWorkspace('TAREAS');setView('TODAS');setFilters(EMPTY_FILTERS);setPage(1);openEdit(tarea);}catch{if(taskOpenGuardRef.current.isCurrent(token))setError('No fue posible localizar la tarea.');}};
  const closeForm = () => { if (savingRef.current) return; setShowForm(false); setEditing(null); attemptKey.current = null; };

  const submitForm = async () => {
    if (!client || savingRef.current) return;
    const canonicalDate = datetimeLocalToCanonical(form.fecha);
    if (!canonicalDate) { setError('Ingrese una fecha y hora válidas.'); return; }
    savingRef.current = true; setSaving(true); setError('');
    try {
      const result = editing
        ? await client.edit(editing, { tipo: form.tipo, titulo: form.titulo, descripcion: form.descripcion || null, fecha_programada: canonicalDate, prioridad: form.prioridad, responsable: form.responsable })
        : await client.create({ cliente: form.cliente, promesa_id:form.promesaId, tipo: form.tipo, titulo: form.titulo, descripcion: form.descripcion || null, fecha_programada: canonicalDate, prioridad: form.prioridad, responsable: form.responsable, idempotency_key: attemptKey.current ?? crypto.randomUUID() } as TareaCreateInput);
      if (result.ok === false) { setError(taskErrorMessage(result)); return; }
      setShowForm(false); setEditing(null); attemptKey.current = null; await refresh();
    } catch { setError('No fue posible guardar la tarea.'); }
    finally { savingRef.current = false; setSaving(false); }
  };

  const mutate = async (operation: () => ReturnType<NonNullable<typeof client>['complete']>) => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try { const result = await operation(); if (result.ok === false) { setError(taskErrorMessage(result)); return; } await refresh(); }
    catch { setError('No fue posible actualizar la tarea.'); }
    finally { savingRef.current = false; setSaving(false); }
  };

  const cancelTask = (tarea: Tarea) => {
    const confirmed = window.confirm(`¿Cancelar la tarea “${tarea.titulo}”?`);
    if (!confirmed || !client) return;
    const motivo = window.prompt('Motivo de cancelación (opcional):') ?? undefined;
    void mutate(() => client.cancel(tarea, motivo));
  };

  const openHistory = (tarea: Tarea) => { historyGuardRef.current.invalidate(); historyTaskIdRef.current = tarea.id; eventPageRef.current = 1; historyOpenRef.current = true; setHistoryTask(tarea); setEventPage(1); setEvents([]); setEventPages(0); setHistoryError(null); setHistoryLoading(true); };
  const closeHistory = () => { historyGuardRef.current.invalidate(); historyTaskIdRef.current = null; historyOpenRef.current = false; setHistoryTask(null); setEvents([]); setEventPages(0); setHistoryError(null); setHistoryLoading(false); };
  const changeEventPage = (next: number) => { eventPageRef.current = next; setEventPage(next); };
  useEffect(() => {
    if (!client || !historyTask) return;
    const tareaId = historyTask.id;
    const requestedPage = eventPage;
    const token = historyGuardRef.current.begin(tareaId, requestedPage);
    setHistoryLoading(true); setHistoryError(null);
    void client.events({ tareaId, page: requestedPage, pageSize: 10 }).then(result => {
      if (!historyGuardRef.current.isCurrent(token, historyTaskIdRef.current, eventPageRef.current, historyOpenRef.current)) return;
      if (isTaskError(result)) { setHistoryError(taskErrorMessage(result)); setEvents([]); return; }
      setEvents(result.items); setEventPages(result.totalPages);
    }).catch(() => {
      if (historyGuardRef.current.isCurrent(token, historyTaskIdRef.current, eventPageRef.current, historyOpenRef.current)) { setHistoryError('No fue posible cargar el historial.'); setEvents([]); }
    }).finally(() => {
      if (historyGuardRef.current.isCurrent(token, historyTaskIdRef.current, eventPageRef.current, historyOpenRef.current)) setHistoryLoading(false);
    });
  }, [client, eventPage, historyTask]);

  const hasFilters = Object.values(filters).some(Boolean);
  return <section className="seguimientos-page" data-testid="seguimientos-page">
    <header className="seguimientos-header"><div><h2>Seguimientos</h2><p>Actividades operativas del CRM, priorizadas por fecha y estado.</p></div><div className="seguimientos-header-actions"><button className="btn secondary" type="button" aria-expanded={filtersVisible} onClick={() => setFiltersVisible(value => !value)}>{filtersVisible ? 'Ocultar filtros' : 'Mostrar filtros'}</button><button className="btn primary" onClick={openCreate}>＋ Nueva tarea</button></div></header>
    <div className="seguimientos-views" aria-label="Área de trabajo"><button className={`btn ${workspace==='BANDEJA'?'primary':'secondary'}`} onClick={()=>setWorkspace('BANDEJA')}>Bandeja</button><button className={`btn ${workspace==='TAREAS'?'primary':'secondary'}`} onClick={()=>setWorkspace('TAREAS')}>Tareas</button><button className={`btn ${workspace==='ALERTAS'?'primary':'secondary'}`} onClick={()=>setWorkspace('ALERTAS')}>Alertas</button></div>
    {workspace==='BANDEJA'&&api?.bandejaOperativaListar&&api.bandejaOperativaResumen?<BandejaOperativaPanel api={api as BandejaOperativaApi} filtersVisible={filtersVisible} onCreateTask={createFromBandeja} onOpenTask={id=>void openTaskFromBandeja(id)}/>:workspace==='ALERTAS'&&client?<AlertasOperativasPanel api={api as SeguimientosApi} filtersVisible={filtersVisible} onCreateTask={createFromAlert} onOpenTask={openTaskFromAlert}/>:<>
    <div className="seguimientos-views" aria-label="Vistas rápidas">{SEGUIMIENTO_VIEWS.map(item => <button key={item} className={`btn ${view === item ? 'primary' : 'secondary'}`} onClick={() => selectView(item)}>{VIEW_LABELS[item]}</button>)}</div>
    <div className="seguimientos-kpis">{(['HOY', 'VENCIDA', 'PROXIMA', 'COMPLETADA'] as const).map(item => <button className="seguimientos-kpi" key={item} onClick={() => selectView(item)}><span>{VIEW_LABELS[item]}</span><strong>{counts[item]}</strong></button>)}</div>
    {filtersVisible && <div className="card"><div className="seguimientos-card-header"><div className="card-title">Filtros</div>{hasFilters && <button className="btn secondary" onClick={() => { setFilters(EMPTY_FILTERS); setPage(1); }}>Limpiar</button>}</div><div className="seguimientos-filters">
      <label className="field"><span>Cliente</span><input value={filters.cliente} onChange={e => changeFilter('cliente', e.target.value)} /></label>
      <label className="field"><span>Responsable</span><input value={filters.responsable} onChange={e => changeFilter('responsable', e.target.value)} /></label>
      <label className="field"><span>Tipo</span><select value={filters.tipo} onChange={e => changeFilter('tipo', e.target.value)}><option value="">Todos</option>{TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label className="field"><span>Prioridad</span><select value={filters.prioridad} onChange={e => changeFilter('prioridad', e.target.value)}><option value="">Todas</option>{PRIORITIES.map(item => <option key={item}>{item}</option>)}</select></label>
      <label className="field"><span>Estado</span><select value={filters.estado} onChange={e => changeFilter('estado', e.target.value)}><option value="">Vista actual</option><option>PENDIENTE</option><option>EN_PROGRESO</option><option>CANCELADA</option></select></label>
      <label className="field"><span>Desde</span><input type="date" value={filters.fechaDesde} onChange={e => changeFilter('fechaDesde', e.target.value)} /></label>
      <label className="field"><span>Hasta</span><input type="date" value={filters.fechaHasta} onChange={e => changeFilter('fechaHasta', e.target.value)} /></label>
      <label className="field wide"><span>Buscar</span><input type="search" value={filters.search} placeholder="Cliente, título o descripción" onChange={e => changeFilter('search', e.target.value)} /></label>
    </div></div>}
    {error && <div className="seguimientos-error" role="alert">{error}</div>}
    <div className="card"><div className="seguimientos-card-header"><div className="card-title">Tareas</div><span>{total} resultado{total === 1 ? '' : 's'}</span></div>
      {loading ? <div className="seguimientos-state">Cargando seguimientos…</div> : items.length === 0 ? <div className="seguimientos-state seguimientos-empty-state"><strong>{hasFilters ? 'No hay resultados con los filtros seleccionados.' : 'No hay tareas en esta vista.'}</strong><span>{hasFilters ? 'Prueba con otros criterios o limpia los filtros.' : 'Las tareas pendientes aparecerán aquí cuando estén disponibles.'}</span></div> : <div className="table-wrapper"><table className="data-table"><thead><tr><th>Fecha programada</th><th>Cliente</th><th>Tipo</th><th>Título</th><th>Prioridad</th><th>Estado operativo</th><th>Responsable</th><th>Origen</th><th>Acciones</th></tr></thead><tbody>{items.map(tarea => {
        const terminal = tarea.estado === 'COMPLETADA' || tarea.estado === 'CANCELADA'; const operational = tarea.estado_operativo ?? tarea.estado;
        return <tr key={tarea.id}><td>{friendlyTaskDate(tarea.fecha_programada)}</td><td><strong>{tarea.cliente}</strong></td><td>{TYPES.find(([id]) => id === tarea.tipo)?.[1] ?? tarea.tipo}</td><td title={tarea.descripcion ?? ''}>{tarea.titulo}</td><td><span className={`seguimientos-badge ${tarea.prioridad.toLowerCase()}`}>{tarea.prioridad}</span></td><td><span className={`seguimientos-badge ${operational.toLowerCase()}`}>{operational}</span></td><td>{tarea.responsable}</td><td>{tareaOrigin(tarea)}</td><td><div className="seguimientos-row-actions"><button className="btn primary" disabled={saving} onClick={() => client && void mutate(() => client.complete(tarea))}>Completar</button><details className="seguimientos-action-menu"><summary className="btn secondary">Más acciones</summary><div className="seguimientos-action-menu__items" role="menu"><button className="btn secondary" onClick={() => openHistory(tarea)}>Historial</button>{!terminal && <><button className="btn secondary" onClick={() => openEdit(tarea)}>Editar</button>{tarea.estado === 'PENDIENTE' ? <button className="btn secondary" disabled={saving} onClick={() => client && void mutate(() => client.changeState(tarea, 'EN_PROGRESO'))}>Iniciar</button> : <button className="btn secondary" disabled={saving} onClick={() => client && void mutate(() => client.changeState(tarea, 'PENDIENTE'))}>Volver a pendiente</button>}<button className="btn secondary" disabled={saving} onClick={() => cancelTask(tarea)}>Cancelar</button></>}{tarea.estado === 'COMPLETADA' && onRegisterGestion && <button className="btn secondary" onClick={() => onRegisterGestion(tarea.cliente)}>Registrar gestión</button>}</div></details></div></td></tr>;
      })}</tbody></table></div>}
      <div className="seguimientos-pagination"><span>Página {page} de {Math.max(1, totalPages)}</span><div className="seguimientos-actions"><label>Filas <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); }}><option>25</option><option>50</option><option>100</option></select></label><button className="btn secondary" disabled={page <= 1} onClick={() => setPage(current => current - 1)}>Anterior</button><button className="btn secondary" disabled={totalPages === 0 || page >= totalPages} onClick={() => setPage(current => current + 1)}>Siguiente</button></div></div>
    </div></>}
    {showForm && <div className="modal-overlay" onClick={closeForm}><div className="modal seguimientos-modal" onClick={e => e.stopPropagation()}><div className="modal-header">{editing ? 'Editar tarea' : 'Nueva tarea'}</div><div className="modal-body seguimientos-form-grid">
      <label className="field"><span>Cliente</span><input disabled={Boolean(editing)} value={form.cliente} onChange={e => setForm(current => ({ ...current, cliente: e.target.value }))} /></label><label className="field"><span>Tipo</span><select value={form.tipo} onChange={e => setForm(current => ({ ...current, tipo: e.target.value as TareaTipo }))}>{TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label className="field full"><span>Título</span><input value={form.titulo} onChange={e => setForm(current => ({ ...current, titulo: e.target.value }))} /></label><label className="field full"><span>Descripción</span><textarea rows={3} value={form.descripcion} onChange={e => setForm(current => ({ ...current, descripcion: e.target.value }))} /></label><label className="field"><span>Fecha programada</span><input type="datetime-local" value={form.fecha} onChange={e => setForm(current => ({ ...current, fecha: e.target.value }))} /></label><label className="field"><span>Prioridad</span><select value={form.prioridad} onChange={e => setForm(current => ({ ...current, prioridad: e.target.value as TareaPrioridad }))}>{PRIORITIES.map(item => <option key={item}>{item}</option>)}</select></label><label className="field full"><span>Responsable</span><input value={form.responsable} onChange={e => setForm(current => ({ ...current, responsable: e.target.value }))} /></label>
    </div><div className="modal-footer"><button className="btn secondary" disabled={saving} onClick={closeForm}>Cancelar</button><button className="btn primary" disabled={saving} onClick={() => void submitForm()}>{saving ? 'Guardando…' : 'Guardar'}</button></div></div></div>}
    {historyTask && <div className="modal-overlay" onClick={closeHistory}><div className="modal seguimientos-modal" onClick={e => e.stopPropagation()}><div className="modal-header">Historial · {historyTask.titulo}</div><div className="modal-body"><HistoryContent loading={historyLoading} error={historyError} events={events} /></div><div className="modal-footer"><button className="btn secondary" disabled={historyLoading || eventPage <= 1} onClick={() => changeEventPage(eventPage - 1)}>Anterior</button><span>{eventPage} / {eventPages || 1}</span><button className="btn secondary" disabled={historyLoading || eventPage >= eventPages} onClick={() => changeEventPage(eventPage + 1)}>Siguiente</button><button className="btn primary" onClick={closeHistory}>Cerrar</button></div></div></div>}
  </section>;
}

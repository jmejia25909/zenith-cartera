interface EmpresaHeader {
  nombre?: string;
  administrador?: string;
  logo?: string;
}

interface AppHeaderProps {
  empresa: EmpresaHeader;
  isWeb: boolean;
  remoteUrl: string;
  remoteUrlHealthy: boolean;
  repoUrl: string;
  localUrlHealthy: boolean;
  onCopyUrl: (value: string) => void;
  onRefresh: () => void;
}

export function AppHeader({
  empresa,
  isWeb,
  repoUrl,
  localUrlHealthy,
  onCopyUrl,
  onRefresh,
}: AppHeaderProps) {
  return (
    <header className="app-header powerbi-app-header">
      <div className="powerbi-brand">
        <div className="powerbi-brand__logo">
          {empresa.logo?.trim() ? <>
            <img
              src={empresa.logo}
              alt="Logo de la empresa"
              onError={(event) => {
                event.currentTarget.hidden = true;
                event.currentTarget.nextElementSibling?.removeAttribute('hidden');
              }}
            />
            <span className="powerbi-brand__logo-text" hidden aria-label="FreePlastic">FreePlastic</span>
          </> : <span className="powerbi-brand__logo-text" aria-label="FreePlastic">FreePlastic</span>}
        </div>

        <div className="powerbi-brand__identity">
          <h1>{empresa.nombre || 'Cartera Dashboard'}</h1>

          {empresa.administrador && (
            <span>♟ {empresa.administrador}</span>
          )}
        </div>
      </div>

      <div className="powerbi-app-header__actions">
        <button
          type="button"
          className={`powerbi-connection ${
            localUrlHealthy
              ? 'powerbi-connection--online'
              : 'powerbi-connection--offline'
          }`}
          onClick={() => repoUrl && onCopyUrl(repoUrl)}
          disabled={!repoUrl}
          title={
            repoUrl
              ? `Red local: ${repoUrl}. Clic para copiar.`
              : 'Red local no disponible'
          }
        >
          <i />
          Local
        </button>

        <div
          className="powerbi-database"
          title={
            isWeb
              ? 'Aplicación conectada mediante modo web'
              : 'Base SQLite local conectada'
          }
        >
          <span>▣</span>
          {isWeb ? 'Modo Web' : 'Base Local'}
        </div>

        <button
          type="button"
          className="powerbi-global-refresh"
          onClick={onRefresh}
          title="Actualizar toda la información"
        >
          ↻ Actualizar
        </button>
      </div>
    </header>
  );
}

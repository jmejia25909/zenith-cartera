import type { BandejaOperativaQuery } from '../types/bandejaOperativa';

export type BandejaPeriodo = 'INICIAL'|'HOY'|'SIETE_DIAS'|'PERSONALIZADO';

export function createBandejaRequestGuard(){let sequence=0;return{begin(){return++sequence;},invalidate(){sequence+=1;},isCurrent(token:number){return token===sequence;}};}

function localDate(value:Date):string {const p=(part:number)=>String(part).padStart(2,'0');return `${value.getFullYear()}-${p(value.getMonth()+1)}-${p(value.getDate())}`;}
function addDays(value:Date,days:number):string {const date=new Date(value.getFullYear(),value.getMonth(),value.getDate()+days);return localDate(date);}
export function bandejaCanonicalNow(value=new Date()):string {const p=(part:number)=>String(part).padStart(2,'0');return `${localDate(value)} ${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`;}

export function buildBandejaPeriod(periodo:BandejaPeriodo,now:Date,custom:{desde?:string;hasta?:string}={}):Pick<BandejaOperativaQuery,'fechaDesde'|'fechaHasta'> {
  const today=localDate(now);
  if(periodo==='INICIAL') return {fechaHasta:addDays(now,3)};
  if(periodo==='HOY') return {fechaDesde:today,fechaHasta:today};
  if(periodo==='SIETE_DIAS') return {fechaDesde:today,fechaHasta:addDays(now,7)};
  return {...(custom.desde?{fechaDesde:custom.desde}:{}),...(custom.hasta?{fechaHasta:custom.hasta}:{})};
}

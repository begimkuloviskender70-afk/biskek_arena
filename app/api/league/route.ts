import { env } from 'cloudflare:workers';
import { getCurrentUser, assertSameOrigin } from '@/lib/auth';
import { readLeague, mutateLeague, LeagueError } from '@/lib/league';
import { syncFaceit, FaceitError } from '@/lib/faceit';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'no-store'};
function db() { if(!env.DB) throw new LeagueError('База данных временно недоступна.',503); return env.DB; }
function failure(error:unknown) {
 if(error instanceof Response) return error;
 if(error instanceof LeagueError) return Response.json({error:error.message},{status:error.status,headers});
 if(error instanceof FaceitError) return Response.json({error:error.code==='not_configured'?'Интеграция FACEIT пока не настроена.':'FACEIT временно недоступен. Последние данные сохранены.'},{status:503,headers});
 if(String(error).includes('UNIQUE constraint')) return Response.json({error:'Этот тег уже занят или игрок уже состоит в команде.'},{status:409,headers});
 console.error('League operation failed',error instanceof Error?error.message:'unknown');
 return Response.json({error:'Не удалось выполнить действие. Повторите попытку.'},{status:500,headers});
}
export async function GET(request:Request) {
 try{return Response.json(await readLeague(db(),await getCurrentUser(request),Boolean((env as unknown as Record<string,unknown>).FACEIT_API_KEY)),{headers});}catch(e){return failure(e);}
}
export async function POST(request:Request) {
 try{
  assertSameOrigin(request);
  if(!request.headers.get('content-type')?.includes('application/json')) throw new LeagueError('Ожидается JSON.',415);
  const raw=await request.text(); if(raw.length>4096)throw new LeagueError('Запрос слишком большой.',413);
  const user=await getCurrentUser(request); if(!user)throw new LeagueError('Войдите через Steam.',401);
  let input:Record<string,unknown>; try { input=JSON.parse(raw); } catch { throw new LeagueError('Некорректный JSON.'); }
  if(!input||typeof input!=='object'||Array.isArray(input))throw new LeagueError('Некорректный запрос.');
  if(input.action==='syncFaceit') await syncFaceit(db(),user);
  else await mutateLeague(db(),user,input);
  const current=await getCurrentUser(request);
  return Response.json(await readLeague(db(),current,Boolean((env as unknown as Record<string,unknown>).FACEIT_API_KEY)),{headers});
 }catch(e){return failure(e);}
}

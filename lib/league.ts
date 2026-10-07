import type { User, Team, Challenge, LeagueState, TeamMember } from './types';

export class LeagueError extends Error { constructor(message: string, public status = 400) { super(message); } }
const WINDOW = 3 * 60 * 60 * 1000;
const COLORS = ['olive', 'coral', 'blue', 'violet', 'navy'];
function clean(value: unknown, label: string, min: number, max: number) {
 if (typeof value !== 'string') throw new LeagueError(`Укажите ${label}.`);
 const result = value.trim();
 if (result.length < min || result.length > max || /[\u0000-\u0008\u000b-\u001f]/.test(result)) throw new LeagueError(`${label}: от ${min} до ${max} символов.`);
 return result;
}
function level(value: unknown) { if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 10) throw new LeagueError('Уровень FACEIT должен быть от 1 до 10.'); return Number(value); }
function changed(result: D1Result, message: string) { if (!result.meta.changes) throw new LeagueError(message, 409); }
async function captain(db: D1Database, user: User) {
 const team = await db.prepare('SELECT * FROM teams WHERE captain_id = ?').bind(user.id).first<Team>();
 if (!team) throw new LeagueError('Это действие доступно капитану команды.', 403);
 return team;
}

export async function readLeague(db: D1Database, user: User | null, faceitConfigured: boolean): Promise<LeagueState> {
 const [cs, ms, ps] = await Promise.all([
  db.prepare(`SELECT * FROM challenges
   WHERE id IN (SELECT id FROM challenges WHERE status='open' AND scheduled_at>? ORDER BY scheduled_at DESC LIMIT 200)
   OR team_id IN (SELECT team_id FROM members WHERE user_id=?)
   OR opponent_team_id IN (SELECT team_id FROM members WHERE user_id=?)
   ORDER BY scheduled_at DESC`).bind(Date.now(),user?.id??'',user?.id??'').all<Challenge>(),
  db.prepare('SELECT m.team_id, m.user_id, m.role, u.nickname, u.steam_id, u.avatar, u.faceit_level FROM members m JOIN users u ON u.id=m.user_id ORDER BY m.joined_at').all<TeamMember & {team_id:string}>(),
  db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 200').all<User>(),
 ]);
 const challengeTeamIds=[...new Set(cs.results.flatMap(challenge=>[challenge.team_id,challenge.opponent_team_id].filter(Boolean) as string[]))];
 const teamQuery=`SELECT * FROM teams WHERE id IN (SELECT id FROM teams ORDER BY created_at DESC LIMIT 200)
  OR id IN (SELECT team_id FROM members WHERE user_id=?)${challengeTeamIds.length?` OR id IN (${challengeTeamIds.map(()=>'?').join(',')})`:''} ORDER BY created_at DESC`;
 const ts=await db.prepare(teamQuery).bind(user?.id??'',...challengeTeamIds).all<Team & {invite_code:string}>();
 const teams = ts.results.map(t => { const {invite_code,...rest}=t; return {...rest,members:ms.results.filter(m=>m.team_id===t.id),...(user?.id===t.captain_id?{invite_code}:{})}; });
 return {user, teams, challenges:cs.results, players:ps.results, serverConnected:false, faceitConfigured, now:Date.now()};
}

export async function mutateLeague(db: D1Database, user: User, input: Record<string, unknown>, now = Date.now()) {
 if (!user) throw new LeagueError('Войдите через Steam.', 401);
 const action = input.action;
 if (action === 'updateProfile') {
  const nickname=clean(input.nickname,'ник',2,32);
  await db.prepare('UPDATE users SET nickname=? WHERE id=?').bind(nickname,user.id).run(); return;
 }
 if (action === 'createTeam') {
  const name=clean(input.name,'название команды',3,32);
  const tag=clean(input.tag,'тег команды',2,6).toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(tag)) throw new LeagueError('Тег: 2–6 латинских букв или цифр.');
  const description=clean(input.description??'','описание',0,280);
  const color=COLORS.includes(String(input.color))?String(input.color):'olive';
  const id=crypto.randomUUID(), code=crypto.randomUUID().replaceAll('-','');
  const result=await db.batch([
   db.prepare('INSERT INTO teams(id,name,tag,description,captain_id,invite_code,color,created_at) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM members WHERE user_id=?)').bind(id,name,tag,description,user.id,code,color,now,user.id),
   db.prepare("INSERT INTO members(team_id,user_id,role,joined_at) SELECT ?,?,'captain',? WHERE EXISTS(SELECT 1 FROM teams WHERE id=?)").bind(id,user.id,now,id),
  ]);
  changed(result[0],'Вы уже состоите в команде.'); return;
 }
 if (action === 'joinTeam') {
  const inviteCode=clean(input.inviteCode,'код приглашения',32,32);
  if (!/^[a-f0-9]{32}$/.test(inviteCode)) throw new LeagueError('Некорректное приглашение.');
  const result=await db.prepare(`INSERT INTO members(team_id,user_id,role,joined_at)
   SELECT t.id,?,'player',? FROM teams t WHERE t.invite_code=?
   AND NOT EXISTS(SELECT 1 FROM members WHERE user_id=?)
   AND (SELECT COUNT(*) FROM members WHERE team_id=t.id)<5
   AND NOT EXISTS(SELECT 1 FROM challenges c WHERE (c.team_id=t.id OR c.opponent_team_id=t.id) AND c.status IN ('open','accepted') AND c.scheduled_at>?)`)
   .bind(user.id,now,inviteCode,user.id,now-WINDOW).run();
  changed(result,'Приглашение недействительно, состав занят матчем или уже заполнен. У игрока может быть одна команда.'); return;
 }
 if (action === 'leaveTeam') {
  const team=await db.prepare('SELECT t.* FROM teams t JOIN members m ON m.team_id=t.id WHERE m.user_id=?').bind(user.id).first<Team>();
  if(!team) throw new LeagueError('Вы не состоите в команде.');
  if(team.captain_id===user.id) throw new LeagueError('Капитан пока не может покинуть команду. Обратитесь к организатору.',409);
  const result=await db.prepare(`DELETE FROM members WHERE user_id=? AND NOT EXISTS(SELECT 1 FROM challenges c WHERE (c.team_id=? OR c.opponent_team_id=?) AND c.status IN ('open','accepted') AND c.scheduled_at>?)`).bind(user.id,team.id,team.id,now-WINDOW).run();
  changed(result,'Состав зафиксирован для ближайшего матча. Сначала отмените вызов.'); return;
 }
 if (action === 'createChallenge') {
  const team=await captain(db,user);
  const at=Number(input.scheduledAt);
  if (!Number.isSafeInteger(at)||at<now+10*60*1000||at>now+30*86400000) throw new LeagueError('Выберите время от 10 минут до 30 дней вперёд.');
  const min=level(input.minLevel),max=level(input.maxLevel);
  if(min>max) throw new LeagueError('Минимальный уровень не может превышать максимальный.');
  const note=clean(input.note??'','комментарий',0,280);
  const result=await db.prepare(`INSERT INTO challenges(id,team_id,status,scheduled_at,format,min_level,max_level,note,created_at)
   SELECT ?,?,'open',?,'bo1',?,?,?,? WHERE (SELECT COUNT(*) FROM members WHERE team_id=?)=5
   AND NOT EXISTS(SELECT 1 FROM challenges WHERE (team_id=? OR opponent_team_id=?) AND status IN ('open','accepted') AND scheduled_at>? AND scheduled_at<?)`)
   .bind(crypto.randomUUID(),team.id,at,min,max,note,now,team.id,team.id,team.id,at-WINDOW,at+WINDOW).run();
  changed(result,'Нужны пять игроков и свободное время: между матчами оставьте не менее трёх часов.'); return;
 }
 if (action === 'acceptChallenge') {
  const team=await captain(db,user);
  const id=clean(input.challengeId,'идентификатор вызова',1,80);
  const result=await db.batch([
   db.prepare(`UPDATE challenges SET opponent_team_id=?,status='accepted',accepted_at=? WHERE id=? AND status='open' AND team_id<>? AND scheduled_at>?
    AND (SELECT COUNT(*) FROM members WHERE team_id=challenges.team_id)=5
    AND (SELECT COUNT(*) FROM members WHERE team_id=?)=5
    AND ((min_level=1 AND max_level=10) OR (
      (SELECT COUNT(u.faceit_level) FROM members m JOIN users u ON u.id=m.user_id WHERE m.team_id=? AND u.faceit_updated_at>=?)=5
      AND (SELECT AVG(u.faceit_level) FROM members m JOIN users u ON u.id=m.user_id WHERE m.team_id=?) BETWEEN min_level AND max_level))
    AND NOT EXISTS(SELECT 1 FROM challenges other WHERE other.id<>challenges.id AND (other.team_id=? OR other.opponent_team_id=?) AND other.status IN ('open','accepted') AND ABS(other.scheduled_at-challenges.scheduled_at)<?)`)
    .bind(team.id,now,id,team.id,now,team.id,team.id,now-86400000,team.id,team.id,team.id,WINDOW),
   db.prepare(`INSERT OR IGNORE INTO match_players(challenge_id,user_id,team_id,steam_id)
    SELECT c.id,m.user_id,m.team_id,u.steam_id FROM challenges c JOIN members m ON m.team_id=c.team_id OR m.team_id=c.opponent_team_id JOIN users u ON u.id=m.user_id
    WHERE c.id=? AND c.status='accepted' AND c.opponent_team_id=? AND c.accepted_at=?`).bind(id,team.id,now),
  ]);
  changed(result[0],'Вызов уже занят, время пересекается, состав неполный или уровень не подходит. Для ограничений по FACEIT всем пяти игрокам нужны данные не старше суток.'); return;
 }
 if (action === 'cancelChallenge') {
  const team=await captain(db,user),id=clean(input.challengeId,'идентификатор вызова',1,80);
  const result=await db.prepare("UPDATE challenges SET status='cancelled' WHERE id=? AND status IN ('open','accepted') AND (team_id=? OR opponent_team_id=?)").bind(id,team.id,team.id).run();
  changed(result,'Вызов не найден или у вас нет права его отменить.'); return;
 }
 throw new LeagueError('Неизвестное действие.');
}

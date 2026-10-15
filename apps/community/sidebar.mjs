const fail=(message)=>Object.assign(new Error(message),{status:400});
const idPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxRoomOrder=1000;
export function createSidebarStore(db) {
  const get=db.prepare('SELECT value FROM settings WHERE key=?');
  const put=db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const memberships=db.prepare('SELECT room_id FROM room_members WHERE user_id=?');
  function accessibleOrder(userId,value){
    if(!Array.isArray(value))return [];
    const allowed=new Set(memberships.all(userId).map(row=>row.room_id));
    return [...new Set(value.filter(id=>typeof id==='string'&&idPattern.test(id)&&allowed.has(id)))].slice(0,maxRoomOrder);
  }
  function read(userId){
    try {const data=JSON.parse(get.get('sidebar:'+userId)?.value||'{}');return {width:data.width||280,groups:data.groups||[],roomOrder:accessibleOrder(userId,data.roomOrder)};}
    catch{return {width:280,groups:[],roomOrder:[]};}
  }
  return {
    read,
    write(userId,body){
      if(!Number.isInteger(body.width)||body.width<200||body.width>420||!Array.isArray(body.groups)||body.groups.length>20)throw fail('사이드바 설정을 확인해주세요.');
      const ids=new Set();
      const groups=body.groups.map(group=>{
        if(!group||!idPattern.test(group.id)||ids.has(group.id)||typeof group.name!=='string'||!group.name.trim()||group.name.trim().length>40||typeof group.collapsed!=='boolean')throw fail('그룹 이름과 구성을 확인해주세요.');
        ids.add(group.id);return {id:group.id,name:group.name.trim(),collapsed:group.collapsed};
      });
      let roomOrder=read(userId).roomOrder;
      if(Object.hasOwn(body,'roomOrder')){
        if(!Array.isArray(body.roomOrder)||body.roomOrder.length>maxRoomOrder||body.roomOrder.some(id=>typeof id!=='string'||!idPattern.test(id))||new Set(body.roomOrder).size!==body.roomOrder.length)throw fail('대화 순서를 확인해주세요.');
        roomOrder=accessibleOrder(userId,body.roomOrder);
        if(roomOrder.length!==body.roomOrder.length)throw fail('접근할 수 없는 대화가 포함되어 있습니다.');
      }
      db.exec('SAVEPOINT update_sidebar');
      try{
        const prefix='room-ui:'+userId+':';
        for(const row of db.prepare('SELECT key,value FROM settings WHERE substr(key,1,?)=?').all(prefix.length,prefix)){
          const preference=JSON.parse(row.value);
          if(preference.groupId&&!ids.has(preference.groupId))put.run(row.key,JSON.stringify({...preference,groupId:null}));
        }
        const value={width:body.width,groups,roomOrder};put.run('sidebar:'+userId,JSON.stringify(value));db.exec('RELEASE update_sidebar');return value;
      }catch(error){db.exec('ROLLBACK TO update_sidebar; RELEASE update_sidebar');throw error;}
    },
    group(userId,value){
      if(value==null)return null;
      if(typeof value!=='string'||!read(userId).groups.some(group=>group.id===value))throw fail('그룹을 찾을 수 없습니다.');
      return value;
    },
  };
}

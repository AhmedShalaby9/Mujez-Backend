const http=require('node:http');
http.createServer((req,res)=>{
 const match=/^\/api\/v3\/PublicHolidays\/(\d{4})\/EG$/.exec(new URL(req.url,'http://localhost').pathname);
 if(req.method!=='GET'||!match){res.writeHead(501);return res.end('Endpoint outside this dependency contract');}
 const year=Number(match[1]);
 if(year===2025){res.writeHead(503);return res.end('<html>Provider unavailable</html>');}
 res.setHeader('Content-Type','application/json');
 res.end(JSON.stringify([{date:year+'-01-07',name:'Christmas Day (Orthodox)',localName:'عيد الميلاد المجيد',countryCode:year===2024?'US':'EG',global:true,types:['Public']}]));
}).listen(process.env.PORT||4500);

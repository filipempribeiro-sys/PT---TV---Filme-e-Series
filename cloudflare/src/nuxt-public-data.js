// Read Nuxt's serialized public data. Never execute scripts from a remote page.
class DataReader {
  constructor(text, bindings = new Map()) { this.text=text; this.pos=0; this.bindings=bindings; }
  space() { while (/\s/.test(this.text[this.pos]||'') && this.pos<this.text.length) this.pos++; }
  take(char) { this.space(); if(this.text[this.pos]!==char)throw Error('Unsupported Nuxt data'); this.pos++; }
  identifier() { this.space(); const m=this.text.slice(this.pos).match(/^[A-Za-z_$][\w$]*/); if(!m)throw Error('Invalid identifier'); this.pos+=m[0].length; return m[0]; }
  value(depth=0) {
    if(depth>100)throw Error('Nuxt data too deep'); this.space(); const ch=this.text[this.pos];
    if(ch==='"') {
      const start=this.pos++; let escape=false;
      while(this.pos<this.text.length){const c=this.text[this.pos++];if(escape){escape=false;continue}if(c==='\\'){escape=true;continue}if(c==='"')return JSON.parse(this.text.slice(start,this.pos));}
      throw Error('Unterminated string');
    }
    if(ch==='{' || ch==='[') {
      const object=ch==='{', result=object?Object.create(null):[]; this.pos++; this.space(); const end=object?'}':']';
      while(this.text[this.pos]!==end) {
        let key;
        if(object){key=this.text[this.pos]==='"'?this.value(depth+1):this.identifier();if(['__proto__','prototype','constructor'].includes(key))throw Error('Unsafe key');this.take(':');}
        const value=this.value(depth+1);if(object)result[key]=value;else result.push(value);
        this.space();if(this.text[this.pos]!==',')break;this.pos++;this.space();
      }
      this.take(end);return result;
    }
    const number=this.text.slice(this.pos).match(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i);
    if(number){this.pos+=number[0].length;return Number(number[0]);}
    const name=this.identifier();
    if(name==='true')return true;if(name==='false')return false;
    if(['null','undefined','NaN'].includes(name))return null;
    if(name==='void'){this.value(depth+1);return null;}
    if(!this.bindings.has(name))throw Error('Unknown Nuxt binding');
    return this.bindings.get(name);
  }
}

export function readPublicNuxtState(html='') {
  try {
    const script=String(html).match(/<script\b[^>]*>\s*window\.__NUXT__\s*=\s*\(function\(([\w$,]*)\)\{([\s\S]*?)<\/script>/i);
    if(!script || script[2].length>2_000_000)return null;
    const text=script[2], close=text.lastIndexOf('}('), returned=text.lastIndexOf('return ',close);
    if(close<0 || returned<0)return null;
    const args=new DataReader(text.slice(close+2)); const bindings=new Map();
    for(const [index,name] of script[1].split(',').entries()){if(index)args.take(',');bindings.set(name,args.value());}
    args.take(')');args.take(')');args.space();if(args.text[args.pos]===';')args.pos++;args.space();if(args.pos!==args.text.length)throw Error('Unexpected script suffix');
    const assignments=new DataReader(text.slice(0,returned),bindings);
    while(assignments.pos<assignments.text.length) {
      assignments.space();if(assignments.pos===assignments.text.length)break;
      const name=assignments.identifier();const keys=[];assignments.space();
      while(assignments.text[assignments.pos]==='.') {assignments.pos++;keys.push(assignments.identifier());assignments.space();}
      if(!bindings.has(name)||keys.some(key=>['__proto__','prototype','constructor'].includes(key)))throw Error('Unknown or unsafe assignment');
      assignments.take('=');const value=assignments.value();assignments.take(';');
      if(!keys.length)bindings.set(name,value);
      else {let target=bindings.get(name);for(const key of keys.slice(0,-1))target=target?.[key];if(!target||typeof target!=='object')throw Error('Invalid assignment');target[keys.at(-1)]=value;}
    }
    // Only read homepage playlists; unrelated account and translation state is skipped.
    const marker='_homepagePlaylists:', start=text.indexOf(marker,returned);
    if(start<0 || start>=close)return null;
    const result=new DataReader(text.slice(start+marker.length,close),bindings);
    const playlists=result.value();if(!Array.isArray(playlists))return null;
    return {homepage:{_homepagePlaylists:playlists}};
  } catch {return null;}
}

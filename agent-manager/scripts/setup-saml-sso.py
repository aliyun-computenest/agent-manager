#!/usr/bin/env python3
"""
阿里云 IDaaS + Supabase SAML SSO 一键配置脚本

使用方法:
    python scripts/setup-saml-sso.py --help
    python scripts/setup-saml-sso.py --check          # 检查当前配置
    python scripts/setup-saml-sso.py --setup          # 自动配置 SSO
    python scripts/setup-saml-sso.py --cleanup        # 清理配置
"""

import os
import sys
import json
import argparse
import requests
from typing import Optional, Dict, Any
from dataclasses import dataclass

# 尝试导入 IDaaS SDK
try:
    from alibabacloud_eiam20211201.client import Client as EiamClient
    from alibabacloud_tea_openapi import models as open_api_models
    from alibabacloud_eiam20211201 import models as eiam_models
    IDAAS_SDK_AVAILABLE = True
except ImportError:
    IDAAS_SDK_AVAILABLE = False
    print("⚠️  阿里云 IDaaS SDK 未安装，IDaaS 配置功能不可用")
    print("   安装方法: pip install alibabacloud_eiam20211201")


@dataclass
class SSOConfig:
    """SSO 配置参数"""
    # Supabase 配置
    supabase_url: str
    supabase_service_role_key: str
    site_url: str = "http://localhost:5173"
    redirect_urls: str = "http://localhost:5173/"
    
    # IDaaS 配置
    idaas_instance_id: str = ""
    idaas_app_id: str = ""
    idaas_metadata_url: str = ""
    
    # SSO 配置
    sso_domain: str = "openclaw.local"


class SupabaseConfigurator:
    """Supabase 配置管理器"""
    
    def __init__(self, config: SSOConfig):
        self.config = config
        self.base_url = config.supabase_url
        self.headers = {
            "apikey": config.supabase_service_role_key,
            "Authorization": f"Bearer {config.supabase_service_role_key}",
            "Content-Type": "application/json"
        }
    
    def get_settings(self) -> Dict[str, Any]:
        """获取当前认证设置"""
        resp = requests.patch(
            f"{self.base_url}/auth/v1/modify/settings",
            headers=self.headers,
            json={}  # 空 body 会返回当前设置
        )
        resp.raise_for_status()
        return resp.json()
    
    def update_settings(self, settings: Dict[str, Any]) -> Dict[str, Any]:
        """更新认证设置"""
        resp = requests.patch(
            f"{self.base_url}/auth/v1/modify/settings",
            headers=self.headers,
            json=settings
        )
        resp.raise_for_status()
        return resp.json()
    
    def configure_site_url(self) -> bool:
        """配置 site_url 和 redirect_urls"""
        print(f"📝 配置 site_url: {self.config.site_url}")
        print(f"📝 配置 redirect_urls: {self.config.redirect_urls}")
        
        settings = {
            "site_url": self.config.site_url,
            "uri_allow_list": self.config.redirect_urls
        }
        
        result = self.update_settings(settings)
        
        # 验证配置
        if result.get("site_url") == self.config.site_url:
            print("✅ site_url 配置成功")
            return True
        else:
            print("❌ site_url 配置失败")
            return False
    
    def get_sso_providers(self) -> list:
        """获取已注册的 SSO Provider"""
        resp = requests.get(
            f"{self.base_url}/auth/v1/admin/sso/providers",
            headers=self.headers
        )
        resp.raise_for_status()
        return resp.json().get("items", [])
    
    def register_sso_provider(self, metadata_url: str, domains: list) -> Dict[str, Any]:
        """注册 SSO Provider"""
        print(f"📝 注册 SSO Provider...")
        print(f"   Metadata URL: {metadata_url}")
        print(f"   Domains: {domains}")
        
        resp = requests.post(
            f"{self.base_url}/auth/v1/admin/sso/providers",
            headers=self.headers,
            json={
                "type": "saml",
                "metadata_url": metadata_url,
                "domains": domains
            }
        )
        resp.raise_for_status()
        result = resp.json()
        print(f"✅ SSO Provider 注册成功, ID: {result.get('id')}")
        return result
    
    def update_sso_provider(self, provider_id: str, attribute_mapping: Dict = None) -> Dict[str, Any]:
        """更新 SSO Provider"""
        body = {}
        if attribute_mapping is not None:
            body["attribute_mapping"] = attribute_mapping
        
        resp = requests.put(
            f"{self.base_url}/auth/v1/admin/sso/providers/{provider_id}",
            headers=self.headers,
            json=body
        )
        resp.raise_for_status()
        return resp.json()
    
    def delete_sso_provider(self, provider_id: str) -> bool:
        """删除 SSO Provider"""
        resp = requests.delete(
            f"{self.base_url}/auth/v1/admin/sso/providers/{provider_id}",
            headers=self.headers
        )
        return resp.status_code == 200
    
    def check_config(self):
        """检查当前配置"""
        print("\n" + "="*60)
        print("Supabase SSO 配置检查")
        print("="*60)
        
        # 检查认证设置
        settings = self.get_settings()
        
        print(f"\n📋 认证设置:")
        print(f"   site_url: {settings.get('site_url', 'N/A')}")
        print(f"   uri_allow_list: {settings.get('uri_allow_list', 'N/A')}")
        print(f"   saml_enabled: {settings.get('saml_enabled', False)}")
        
        # 检查 site_url 配置
        site_url = settings.get('site_url', '')
        if 'supabase' in site_url.lower():
            print(f"\n⚠️  警告: site_url 设置为 Supabase 地址，SSO 登录后会跳转到 Supabase 而非应用！")
            print(f"   建议修改为: {self.config.site_url}")
        
        # 检查 SSO Providers
        providers = self.get_sso_providers()
        print(f"\n📋 SSO Providers ({len(providers)} 个):")
        
        for p in providers:
            print(f"\n   ID: {p.get('id')}")
            if p.get('saml'):
                print(f"   Entity ID: {p['saml'].get('entity_id', 'N/A')}")
                print(f"   Metadata URL: {p['saml'].get('metadata_url', 'N/A')}")
            domains = p.get('domains', [])
            print(f"   Domains: {[d.get('domain') for d in domains]}")
        
        return True


class IDaaSConfigurator:
    """阿里云 IDaaS 配置管理器"""
    
    def __init__(self, config: SSOConfig):
        self.config = config
        
        if not IDAAS_SDK_AVAILABLE:
            raise RuntimeError("IDaaS SDK 未安装")
        
        ak = os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_ID')
        sk = os.environ.get('ALIBABA_CLOUD_ACCESS_KEY_SECRET')
        
        if not ak or not sk:
            raise RuntimeError("请设置环境变量: ALIBABA_CLOUD_ACCESS_KEY_ID, ALIBABA_CLOUD_ACCESS_KEY_SECRET")
        
        api_config = open_api_models.Config(
            access_key_id=ak,
            access_key_secret=sk,
            endpoint='eiam.cn-hangzhou.aliyuncs.com'
        )
        self.client = EiamClient(api_config)
    
    def get_application(self, app_id: str) -> Dict:
        """获取应用信息"""
        request = eiam_models.GetApplicationRequest(
            instance_id=self.config.idaas_instance_id,
            application_id=app_id
        )
        response = self.client.get_application(request)
        return response.body.application.to_map()
    
    def get_sso_config(self, app_id: str) -> Dict:
        """获取 SSO 配置"""
        request = eiam_models.GetApplicationSsoConfigRequest(
            instance_id=self.config.idaas_instance_id,
            application_id=app_id
        )
        response = self.client.get_application_sso_config(request)
        return response.body.application_sso_config.to_map()
    
    def update_sso_config(self, app_id: str, sp_entity_id: str, sp_acs_url: str) -> str:
        """更新 SAML SSO 配置 (使用正确的表达式语法)"""
        
        # 配置属性声明（关键：不使用 ${} 语法）
        attribute_statements = [
            eiam_models.SetApplicationSsoConfigRequestSamlSsoConfigAttributeStatements(
                attribute_name='email',
                attribute_value_expression='user.email'  # 正确写法
            )
        ]
        
        saml_config = eiam_models.SetApplicationSsoConfigRequestSamlSsoConfig(
            sp_entity_id=sp_entity_id,
            sp_sso_acs_url=sp_acs_url,
            name_id_format='urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
            name_id_value_expression='user.email',  # 关键：不使用 ${user.email}
            assertion_signed=True,
            response_signed=True,
            attribute_statements=attribute_statements
        )
        
        request = eiam_models.SetApplicationSsoConfigRequest(
            instance_id=self.config.idaas_instance_id,
            application_id=app_id,
            saml_sso_config=saml_config,
            init_login_type='idaas_or_app_init_sso'
        )
        
        response = self.client.set_application_sso_config(request)
        return response.body.request_id
    
    def check_config(self):
        """检查 IDaaS 配置"""
        print("\n" + "="*60)
        print("IDaaS SSO 配置检查")
        print("="*60)
        
        if not self.config.idaas_app_id:
            print("⚠️  未配置 IDaaS 应用 ID")
            return False
        
        try:
            # 获取应用信息
            app = self.get_application(self.config.idaas_app_id)
            print(f"\n📋 应用信息:")
            print(f"   应用名称: {app.get('ApplicationName')}")
            print(f"   应用 ID: {app.get('ApplicationId')}")
            print(f"   SSO 类型: {app.get('SsoType')}")
            
            # 获取 SSO 配置
            sso_config = self.get_sso_config(self.config.idaas_app_id)
            saml_config = sso_config.get('SamlSsoConfig', {})
            
            print(f"\n📋 SAML 配置:")
            print(f"   NameID Format: {saml_config.get('NameIdFormat')}")
            print(f"   NameID Expression: {saml_config.get('NameIdValueExpression')}")
            
            # 检查表达式语法
            expression = saml_config.get('NameIdValueExpression', '')
            if '${' in expression:
                print(f"\n⚠️  警告: NameID 表达式使用了 ${{}} 语法，这会导致 Supabase 解析失败！")
                print(f"   当前值: {expression}")
                print(f"   建议修改为: user.email")
            
            # 检查属性声明
            attrs = saml_config.get('AttributeStatements', [])
            print(f"\n📋 属性声明 ({len(attrs)} 个):")
            for attr in attrs:
                print(f"   - {attr.get('AttributeName')}: {attr.get('AttributeValueExpression')}")
            
            return True
            
        except Exception as e:
            print(f"❌ 获取 IDaaS 配置失败: {e}")
            return False


def load_config_from_env() -> SSOConfig:
    """从 .env 文件加载配置"""
    env_path = os.path.join(os.path.dirname(__file__), '..', '.env')
    
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    os.environ[key.strip()] = value.strip()
    
    # 从环境变量构建配置
    supabase_url = os.environ.get('VITE_SUPABASE_URL', '')
    service_role_key = os.environ.get('SERVICE_ROLE_KEY', '')
    
    return SSOConfig(
        supabase_url=supabase_url,
        supabase_service_role_key=service_role_key,
        site_url=os.environ.get('SITE_URL', 'http://localhost:5173'),
        redirect_urls=os.environ.get('REDIRECT_URLS', 'http://localhost:5173/'),
        idaas_instance_id=os.environ.get('IDAAS_INSTANCE_ID', 'idaas_clcabaj7ex7cxu2v6pgb4d6njq'),
        idaas_app_id=os.environ.get('IDAAS_APP_ID', 'app_nhfcxt2kq6alngftcuspv7qzaa'),
        idaas_metadata_url=os.environ.get('IDAAS_METADATA_URL', ''),
        sso_domain=os.environ.get('SSO_DOMAIN', 'openclaw.local')
    )


def cmd_check(args):
    """检查配置命令"""
    config = load_config_from_env()
    
    # 检查 Supabase 配置
    try:
        supabase = SupabaseConfigurator(config)
        supabase.check_config()
    except Exception as e:
        print(f"❌ Supabase 配置检查失败: {e}")
    
    # 检查 IDaaS 配置
    if IDAAS_SDK_AVAILABLE:
        try:
            idaas = IDaaSConfigurator(config)
            idaas.check_config()
        except Exception as e:
            print(f"❌ IDaaS 配置检查失败: {e}")


def cmd_setup(args):
    """配置 SSO 命令"""
    config = load_config_from_env()
    
    print("\n🚀 开始配置 SAML SSO...")
    print("="*60)
    
    # 1. 配置 Supabase site_url
    print("\n[1/3] 配置 Supabase site_url...")
    try:
        supabase = SupabaseConfigurator(config)
        supabase.configure_site_url()
    except Exception as e:
        print(f"❌ 配置失败: {e}")
        return
    
    # 2. 检查/注册 SSO Provider
    print("\n[2/3] 检查 SSO Provider...")
    try:
        providers = supabase.get_sso_providers()
        existing = next((p for p in providers if config.sso_domain in 
                        [d.get('domain') for d in p.get('domains', [])]), None)
        
        if existing:
            print(f"✅ SSO Provider 已存在: {existing.get('id')}")
            provider_id = existing.get('id')
        else:
            if not config.idaas_metadata_url:
                # 构造默认 metadata URL
                config.idaas_metadata_url = f"https://6dy6itcn.aliyunidaas.com/api/v2/{config.idaas_app_id}/saml2/meta"
            
            result = supabase.register_sso_provider(
                metadata_url=config.idaas_metadata_url,
                domains=[config.sso_domain]
            )
            provider_id = result.get('id')
        
        # 配置 attribute_mapping
        print("\n   配置 attribute_mapping...")
        supabase.update_sso_provider(provider_id, {
            "keys": {
                "email": {"name": "email"}
            }
        })
        print("✅ attribute_mapping 配置完成")
        
    except Exception as e:
        print(f"❌ SSO Provider 配置失败: {e}")
        return
    
    # 3. 配置 IDaaS (如果 SDK 可用)
    if IDAAS_SDK_AVAILABLE:
        print("\n[3/3] 配置 IDaaS SAML...")
        try:
            idaas = IDaaSConfigurator(config)
            
            sp_entity_id = f"{config.supabase_url}/auth/v1/sso/saml/metadata"
            sp_acs_url = f"{config.supabase_url}/auth/v1/sso/saml/acs"
            
            request_id = idaas.update_sso_config(
                config.idaas_app_id,
                sp_entity_id,
                sp_acs_url
            )
            print(f"✅ IDaaS SAML 配置更新成功 (RequestId: {request_id})")
            
        except Exception as e:
            print(f"⚠️  IDaaS 配置失败: {e}")
            print("   请手动在 IDaaS 控制台配置，确保:")
            print("   - NameID 表达式使用 'user.email' (不是 '${user.email}')")
            print("   - 添加 email 属性声明")
    else:
        print("\n[3/3] 跳过 IDaaS 配置 (SDK 未安装)")
        print("   请手动在 IDaaS 控制台配置")
    
    print("\n" + "="*60)
    print("✅ SSO 配置完成！")
    print("="*60)
    print(f"\n配置摘要:")
    print(f"  Site URL: {config.site_url}")
    print(f"  SSO Domain: {config.sso_domain}")
    print(f"  IDaaS App: {config.idaas_app_id}")
    print(f"\n现在可以测试 SSO 登录了！")


def cmd_cleanup(args):
    """清理配置命令"""
    config = load_config_from_env()
    
    print("\n🧹 清理 SSO 配置...")
    
    try:
        supabase = SupabaseConfigurator(config)
        providers = supabase.get_sso_providers()
        
        for p in providers:
            provider_id = p.get('id')
            domains = [d.get('domain') for d in p.get('domains', [])]
            
            if config.sso_domain in domains:
                print(f"   删除 Provider: {provider_id}")
                if supabase.delete_sso_provider(provider_id):
                    print(f"   ✅ 已删除")
                else:
                    print(f"   ❌ 删除失败")
        
        print("\n✅ 清理完成")
        
    except Exception as e:
        print(f"❌ 清理失败: {e}")


def main():
    parser = argparse.ArgumentParser(
        description='阿里云 IDaaS + Supabase SAML SSO 一键配置工具',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s --check     检查当前 SSO 配置状态
  %(prog)s --setup     自动配置 SSO (推荐)
  %(prog)s --cleanup   清理 SSO 配置

环境变量:
  VITE_SUPABASE_URL              Supabase URL
  SERVICE_ROLE_KEY               Supabase Service Role Key
  ALIBABA_CLOUD_ACCESS_KEY_ID    阿里云 Access Key ID
  ALIBABA_CLOUD_ACCESS_KEY_SECRET 阿里云 Access Key Secret
  IDAAS_INSTANCE_ID              IDaaS 实例 ID
  IDAAS_APP_ID                   IDaaS 应用 ID
  SSO_DOMAIN                     SSO 域名 (默认: openclaw.local)
"""
    )
    
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--check', action='store_true', help='检查当前配置')
    group.add_argument('--setup', action='store_true', help='自动配置 SSO')
    group.add_argument('--cleanup', action='store_true', help='清理 SSO 配置')
    
    args = parser.parse_args()
    
    if args.check:
        cmd_check(args)
    elif args.setup:
        cmd_setup(args)
    elif args.cleanup:
        cmd_cleanup(args)


if __name__ == '__main__':
    main()
